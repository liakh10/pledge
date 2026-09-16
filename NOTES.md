# Pledge — $PLEDGE (протокол)

Заведён 2026-09-16 из четвёрки по ссылкам Axiom. Референс: triplets.trade (x.com/tripletsdotrade).

## Что это
Монета с условием: существует, только если до дедлайна набрали цель в ETH. Один контракт держит сбор,
лаунч на Pons, монеты бэкеров и «сундук» (chest), который покупает и сжигает, когда резерв кривой ниже
уровня открытия. Не набрали — все забирают ETH назад.

## Снято с референса (Triplets)
- светлая тема, крупный заголовок с одним цветным словом, карточки с тонкой рамкой, строки-списки
- шрифты: Instrument Sans (UI и заголовки) + Roboto Mono (адреса, цифры)
- акцент один: синий #2f6bff

## Реестр (REGISTRY.md)
- модель страницы: доска — hero с «билетом» создания справа, ниже строки пледжей с прогресс-барами,
  страница пледжа `/p/<address>`
- носитель CA: тёмная плита Proof (адреса контрактов списком, $PLEDGE «soon»)
- живая фишка: Chest gauge — читает Pons-кривую напрямую: уровень открытия, резерв сейчас, сколько
  защит потянет сундук; кнопки Defend / Sweep and collect для любого кошелька
- шрифты: Instrument Sans + Roboto Mono

## Контракты (contracts/src/Pledge.sol)
- `PledgeFactory(impl, burner)`: create → клон; MIN_GOAL 0.25 ETH, окно 1ч–7д, tax 100–500 bps;
  guardian только proposeBurner/activateBurner (48 ч)
- `Pledge`: back() с возвратом излишка и `require(room>0,"funded")`; launch() платит fee Pons,
  launchToken с creatorFeeRecipient=this, первая покупка (raised−fee)/2, reserveAtLaunch; claimCoins
  pro rata; refund после дедлайна; sweep/collect (10% бёрнеру)/defend (≤0.05 ETH, только если
  realQuoteReserve < reserveAtLaunch, монеты в dEaD)/run
- Форк-тест `contracts/test.mjs`: **68 passed, 0 failed** (2026-09-16, блок 64639388, 174 RPC-вызова)
  — продажи через `sell(uint256,uint256,address)` прошли, defend отработал

## Что нужно от пользователя перед деплоем
- задеплоить через `/deploy` (implementation → factory с адресом бёрнера), вписать `PLEDGE_FACTORY`,
  `PLEDGE_BURNER` в config.js
- Vercel env: `ROBINHOOD_RPC` (QuickNode, Sensitive), `UPSTASH_REDIS_REST_URL/TOKEN`, `CRON_SECRET`,
  `PLEDGE_OPERATOR_KEY` (кошелёк кипера с небольшим ETH на газ)
- расписание кипера в `.github/workflows/keeper.yml` включать только после деплоя контрактов

## Груз
- `/api/feed` — getLogs через приватный RPC, кэш 60 с
- `/api/tick` — кипер, без расписания до деплоя; после CA + 2 часа снять
