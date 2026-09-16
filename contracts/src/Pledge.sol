// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PonsLaunchParams, PonsSocials, PonsLaunchedToken, IPonsFactory, IPonsCurve, IPonsEscrow, IERC20P, PonsAddrs} from "./Pons.sol";

interface IPledgeInit {
    function initialize(address creator, string calldata name, string calldata symbol, string calldata logo, string calldata description, uint256 goal, uint64 deadline, uint16 taxBps, address burner) external;
}

/// @title Pledge factory
/// Opens a pledge: a coin that only launches once its funding goal is met. Anyone can create one, it costs gas.
/// The factory keeps no money and has no switch that touches a pledge. The guardian can only change where the
/// protocol's small share goes, with a public 48 hour notice.
contract PledgeFactory {
    uint256 public constant MIN_GOAL = 0.25 ether;
    uint256 public constant MIN_WINDOW = 1 hours;
    uint256 public constant MAX_WINDOW = 7 days;
    uint16 public constant MIN_TAX = 100;
    uint16 public constant MAX_TAX = 500;
    uint256 public constant BURNER_DELAY = 48 hours;

    address public immutable impl;
    address public guardian;
    address public pendingGuardian;
    address public burner;
    address public nextBurner;
    uint64 public nextBurnerAt;

    address[] internal _pledges;
    mapping(address => bool) public isPledge;

    event PledgeCreated(address indexed pledge, address indexed creator, string name, string symbol, uint256 goal, uint64 deadline, uint16 taxBps);
    event BurnerProposed(address burner, uint64 activeAt);
    event BurnerSet(address burner);
    event GuardianTransferred(address indexed previous, address indexed next);

    modifier onlyGuardian() { require(msg.sender == guardian, "guardian"); _; }

    constructor(address _impl, address _burner) {
        require(_impl != address(0) && _burner != address(0), "zero");
        impl = _impl;
        burner = _burner;
        guardian = msg.sender;
    }

    function create(string calldata name, string calldata symbol, string calldata logo, string calldata description, uint256 goal, uint256 window, uint16 taxBps) external returns (address pledge) {
        require(bytes(name).length > 0 && bytes(name).length <= 32 && bytes(symbol).length > 0 && bytes(symbol).length <= 10, "name");
        require(goal >= MIN_GOAL, "goal");
        require(window >= MIN_WINDOW && window <= MAX_WINDOW, "window");
        require(taxBps >= MIN_TAX && taxBps <= MAX_TAX, "tax");
        pledge = _clone(impl);
        uint64 deadline = uint64(block.timestamp + window);
        IPledgeInit(pledge).initialize(msg.sender, name, symbol, logo, description, goal, deadline, taxBps, burner);
        _pledges.push(pledge);
        isPledge[pledge] = true;
        emit PledgeCreated(pledge, msg.sender, name, symbol, goal, deadline, taxBps);
    }

    function count() external view returns (uint256) { return _pledges.length; }

    function list(uint256 from, uint256 n) external view returns (address[] memory out) {
        uint256 total = _pledges.length;
        if (from >= total) return new address[](0);
        uint256 end = from + n > total ? total : from + n;
        out = new address[](end - from);
        for (uint256 i = from; i < end; i++) out[i - from] = _pledges[i];
    }

    function proposeBurner(address next) external onlyGuardian {
        require(next != address(0), "zero");
        nextBurner = next;
        nextBurnerAt = uint64(block.timestamp + BURNER_DELAY);
        emit BurnerProposed(next, nextBurnerAt);
    }

    function activateBurner() external {
        require(nextBurner != address(0) && block.timestamp >= nextBurnerAt, "wait");
        burner = nextBurner;
        nextBurner = address(0);
        nextBurnerAt = 0;
        emit BurnerSet(burner);
    }

    function transferGuardian(address next) external onlyGuardian { pendingGuardian = next; }

    function acceptGuardian() external {
        require(msg.sender == pendingGuardian, "pending");
        emit GuardianTransferred(guardian, msg.sender);
        guardian = msg.sender;
        pendingGuardian = address(0);
    }

    function _clone(address i) internal returns (address inst) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, i))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            inst := create(0, ptr, 0x37)
        }
        require(inst != address(0), "clone");
    }
}

/// @title Pledge
/// A coin that launches on Pons only when its goal is reached, with every backer inside the very first buy.
///
/// Backing: send ETH while the window is open. Anything above what is left of the goal goes straight back to the
/// sender. When the goal is hit, anyone calls `launch`: the coin is created on Pons and the first buy is made in the
/// same transaction with half of the raise, so nobody can get in before the backers. Coins are claimed pro rata.
///
/// The other half of the raise is the floor chest. It lives in this contract and can do exactly one thing: buy the
/// coin on its own curve when the curve's reserve has fallen below where it stood at launch, and send what it buys
/// to the dead address. Creator fees of the coin are pointed at this contract, so the chest refills from every trade.
/// If the window closes short of the goal, every backer pulls a full refund. Nothing here can send ETH anywhere else.
contract Pledge {
    uint256 public constant MAX_DEFEND = 0.05 ether;
    uint256 public constant MIN_DEFEND = 0.001 ether;
    uint256 public constant BURNER_BPS = 1000;

    address public factory;
    address public creator;
    string public name;
    string public symbol;
    string public logo;
    string public description;
    uint256 public goal;
    uint64 public deadline;
    uint16 public taxBps;
    address public burner;

    uint8 public phase; // 0 funding, 1 launched, 2 missed
    uint256 public raised;
    mapping(address => uint256) public backed;
    mapping(address => bool) public claimed;
    address[] internal _backers;

    address public token;
    address public curve;
    uint256 public reserveAtLaunch;
    uint256 public coinsForBackers;
    uint256 public launchedAt;
    uint256 public totalDefended;
    uint256 public totalBurnedCoins;
    uint256 public totalCollected;

    bool internal initialized;
    bool internal entered;

    event Backed(address indexed backer, uint256 amount, uint256 refunded, uint256 raised);
    event GoalReached(uint256 raised);
    event Launched(address indexed token, address indexed curve, uint256 firstBuy, uint256 coins, uint256 chest);
    event Claimed(address indexed backer, uint256 coins);
    event Refunded(address indexed backer, uint256 amount);
    event Missed(uint256 raised, uint256 goal);
    event Swept(bool ok);
    event Collected(uint256 eth, uint256 toBurner);
    event Defended(uint256 spent, uint256 coinsBurned, uint256 reserveBefore, uint256 reserveAfter);

    modifier nonReentrant() { require(!entered, "reentrant"); entered = true; _; entered = false; }

    constructor() { initialized = true; }

    function initialize(address _creator, string calldata _name, string calldata _symbol, string calldata _logo, string calldata _description, uint256 _goal, uint64 _deadline, uint16 _taxBps, address _burner) external {
        require(!initialized, "init");
        initialized = true;
        factory = msg.sender;
        creator = _creator;
        name = _name; symbol = _symbol; logo = _logo; description = _description;
        goal = _goal; deadline = _deadline; taxBps = _taxBps; burner = _burner;
    }

    receive() external payable {
        if (phase == 0) _back();
        // after launch, plain ETH is creator fees or curve sweeps landing in the chest
    }

    function back() external payable { _back(); }

    function _back() internal nonReentrant {
        require(phase == 0, "closed");
        require(block.timestamp < deadline, "window over");
        require(msg.value > 0, "empty");
        uint256 room = goal - raised;
        require(room > 0, "funded");
        uint256 take = msg.value > room ? room : msg.value;
        uint256 back_ = msg.value - take;
        if (backed[msg.sender] == 0) _backers.push(msg.sender);
        backed[msg.sender] += take;
        raised += take;
        if (back_ > 0) { (bool ok,) = msg.sender.call{value: back_}(""); require(ok, "refund"); }
        emit Backed(msg.sender, take, back_, raised);
        if (raised >= goal) emit GoalReached(raised);
    }

    /// Creates the coin on Pons and makes the first buy for the backers in the same transaction. Anyone can call it.
    function launch() external nonReentrant returns (address, address) {
        require(phase == 0, "not funding");
        require(raised >= goal, "goal not met");
        phase = 1;
        IPonsFactory pons = IPonsFactory(PonsAddrs.FACTORY);
        uint256 fee = pons.launchFee();
        require(raised > fee * 4, "raise too small for the fee");
        PonsLaunchParams memory p = PonsLaunchParams({
            name: name, symbol: symbol, logo: logo, description: description,
            socials: PonsSocials({twitter: "", telegram: "", discord: "", website: "", farcaster: ""}),
            creatorFeeRecipient: address(this), creatorTaxBps: taxBps, buybackEnabled: false,
            expectedEconomics: pons.previewLaunchEconomics(0, address(0)),
            salt: keccak256(abi.encode(address(this), block.number, raised))
        });
        (token, curve) = pons.launchToken{value: fee}(p, 0, address(0));
        uint256 firstBuy = (raised - fee) / 2;
        uint256 before = IERC20P(token).balanceOf(address(this));
        IPonsCurve(curve).buy{value: firstBuy}(firstBuy, 1, address(this));
        coinsForBackers = IERC20P(token).balanceOf(address(this)) - before;
        reserveAtLaunch = IPonsCurve(curve).realQuoteReserve();
        launchedAt = block.timestamp;
        emit Launched(token, curve, firstBuy, coinsForBackers, address(this).balance);
        return (token, curve);
    }

    /// A backer takes its share of the first buy.
    function claimCoins() external nonReentrant {
        require(phase == 1, "not launched");
        require(backed[msg.sender] > 0 && !claimed[msg.sender], "nothing");
        claimed[msg.sender] = true;
        uint256 share = coinsForBackers * backed[msg.sender] / raised;
        require(IERC20P(token).transfer(msg.sender, share), "transfer");
        emit Claimed(msg.sender, share);
    }

    /// After the window, a pledge that missed its goal gives everything back.
    function refund() external nonReentrant {
        require(phase != 1, "launched");
        require(block.timestamp >= deadline && raised < goal, "still open");
        if (phase == 0) { phase = 2; emit Missed(raised, goal); }
        uint256 amount = backed[msg.sender];
        require(amount > 0, "nothing");
        backed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "send");
        emit Refunded(msg.sender, amount);
    }

    // ---------------------------------------------------------------- the floor chest

    /// Pons records the fee recipient as the curve's deployer, so only this contract can sweep the curve.
    function sweep() public {
        require(phase == 1, "not launched");
        try IPonsCurve(curve).sweepFees(0) { emit Swept(true); } catch { emit Swept(false); }
    }

    /// Claims creator fees from the Pons escrow into the chest, less the protocol's tenth for the $PLEDGE burn.
    function collect() public nonReentrant returns (uint256 got) {
        require(phase == 1, "not launched");
        if (IPonsEscrow(PonsAddrs.ESCROW).balanceOf(address(this)) == 0) return 0;
        uint256 before = address(this).balance;
        IPonsEscrow(PonsAddrs.ESCROW).claim();
        got = address(this).balance - before;
        uint256 toBurner = got * BURNER_BPS / 10_000;
        if (toBurner > 0) { (bool ok,) = burner.call{value: toBurner}(""); if (!ok) toBurner = 0; }
        totalCollected += got;
        emit Collected(got, toBurner);
    }

    /// Buys the coin with the chest when the curve has fallen below its launch reserve, and burns what it buys.
    /// Only ever below the opening level, only up to MAX_DEFEND per call, only while the coin is still on its curve.
    function defend() external nonReentrant returns (uint256 spent, uint256 burned) {
        require(phase == 1, "not launched");
        PonsLaunchedToken memory lt = IPonsFactory(PonsAddrs.FACTORY).getLaunchedToken(token);
        require(lt.phase < 2, "graduated");
        uint256 reserve = IPonsCurve(curve).realQuoteReserve();
        require(reserve < reserveAtLaunch, "at or above opening");
        spent = reserveAtLaunch - reserve;
        if (spent > MAX_DEFEND) spent = MAX_DEFEND;
        if (spent > address(this).balance) spent = address(this).balance;
        require(spent >= MIN_DEFEND, "chest empty");
        uint256 deadBefore = IERC20P(token).balanceOf(PonsAddrs.DEAD);
        IPonsCurve(curve).buy{value: spent}(spent, 1, PonsAddrs.DEAD);
        burned = IERC20P(token).balanceOf(PonsAddrs.DEAD) - deadBefore;
        totalDefended += spent;
        totalBurnedCoins += burned;
        emit Defended(spent, burned, reserve, IPonsCurve(curve).realQuoteReserve());
    }

    /// Sweep, collect and defend in one call, the way the site's button and the keeper do it.
    function run() external returns (uint256 got, uint256 spent) {
        sweep();
        got = collect();
        if (phase == 1) {
            PonsLaunchedToken memory lt = IPonsFactory(PonsAddrs.FACTORY).getLaunchedToken(token);
            if (lt.phase < 2 && IPonsCurve(curve).realQuoteReserve() < reserveAtLaunch && address(this).balance >= MIN_DEFEND) {
                (spent,) = this.defend();
            }
        }
    }

    // ---------------------------------------------------------------- views

    function backerCount() external view returns (uint256) { return _backers.length; }
    function backers(uint256 from, uint256 n) external view returns (address[] memory out, uint256[] memory amounts) {
        uint256 total = _backers.length;
        if (from >= total) return (new address[](0), new uint256[](0));
        uint256 end = from + n > total ? total : from + n;
        out = new address[](end - from);
        amounts = new uint256[](end - from);
        for (uint256 i = from; i < end; i++) { out[i - from] = _backers[i]; amounts[i - from] = backed[_backers[i]]; }
    }
    function chest() external view returns (uint256) { return phase == 1 ? address(this).balance : 0; }
    function state() external view returns (uint8 ph, uint256 raised_, uint256 goal_, uint64 deadline_, uint256 nBackers, address token_, address curve_, uint256 chest_, uint256 reserveNow, uint256 reserveLaunch, uint256 escrowed) {
        ph = phase; raised_ = raised; goal_ = goal; deadline_ = deadline; nBackers = _backers.length; token_ = token; curve_ = curve;
        chest_ = phase == 1 ? address(this).balance : 0;
        reserveNow = curve != address(0) ? IPonsCurve(curve).realQuoteReserve() : 0;
        reserveLaunch = reserveAtLaunch;
        escrowed = IPonsEscrow(PonsAddrs.ESCROW).balanceOf(address(this));
    }
}
