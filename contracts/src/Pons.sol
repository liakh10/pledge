// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Pons V2 on Robinhood Chain: the parts Pledge calls. Addresses verified on chain 4663.
struct PonsSocials {
    string twitter;
    string telegram;
    string discord;
    string website;
    string farcaster;
}

struct PonsLaunchParams {
    string name;
    string symbol;
    string logo;
    string description;
    PonsSocials socials;
    address creatorFeeRecipient;
    uint16 creatorTaxBps;
    bool buybackEnabled;
    bytes32 expectedEconomics;
    bytes32 salt;
}

struct PonsLaunchedToken {
    address token;
    address curve;
    address deployer;
    address creatorFeeRecipient;
    address pairToken;
    uint256 graduationThreshold;
    uint24 poolFee;
    int24 tickSpacing;
    uint16 creatorTaxBps;
    bool buybackEnabled;
    uint8 phase;
    uint256 sweptQuote;
    uint256 sweptTokens;
    uint256 sweptAt;
    bool exists;
}

interface IPonsFactory {
    function launchFee() external view returns (uint256);
    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32);
    function launchToken(PonsLaunchParams calldata params, uint256 launchConfigId, address pairToken) external payable returns (address token, address curve);
    function getLaunchedToken(address token) external view returns (PonsLaunchedToken memory);
    function memeHook() external view returns (address);
}

interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sweepFees(uint256 minBuybackTokensOut) external;
    function realQuoteReserve() external view returns (uint256);
    function graduationThreshold() external view returns (uint256);
    function creatorTaxBalance() external view returns (uint256);
    function quoteFeeBalance() external view returns (uint256);
}

interface IPonsEscrow {
    function balanceOf(address) external view returns (uint256);
    function claim() external;
}

interface IERC20P {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

library PonsAddrs {
    address internal constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address internal constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
}
