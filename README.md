<h1 align="center">Node Binance Trader (NBT)</h1>

<h4 align="center">NBT is a Cryptocurrency Trading Strategy & Portfolio Management Development Framework for <a href='https://www.binance.com/en-AU/register?ref=141340247' target="_new">Binance</a>.</h4>

## About this fork

This is a fork of the source NBT repo, however the focus of my changes are on the trader.ts and associated components. This is the script that receives the buy/sell signals from the NBT Hub (BitcoinVsAltcoins.com) and executes them on Binance. I have not modified the server.

**Important Note:** Many of the new features (e.g. transaction and balance history) are held in memory while the trader is running. The trader will attempt to write these to a configured Postgres database so that important information can be reloaded if the trader restarts. Using the database is optional, but without it you will lose the history every time the trader restarts. If you choose to deploy to Heroku then the database will automatically be set up.

The new features that I have added to the trader include:
* ***CONFIG:* Quantity as Fraction**
  * If enabled, this will interpret the "Quantity to spend per trade" that you have configured on the NBT Hub as a fraction of your total balance in [Binance](https://www.binance.com/en-AU/register?ref=141340247). E.g. if you say 0.1 BTC it will actually spend 10% of your balance on each trade. However, it will only use the balance from a single wallet, it will not add the two together. This will apply to both SHORT and LONG trades, even though SHORT will not use the actual balance. Both trades will always be calculated relative the **Primary Wallet** (see below), regardless of which wallet is actually chosen to execute the trade.
  * As the funds can be locked up in active trades, the trader will calculate an estimated total balance rather than just using the current free balance. This may not always be exactly right because it uses the original price when the trades were opened, not the current market price.
  * To improve performance the trader will cache the balance of each wallet for up to 24 hours. So if you have manually moved funds in Binance it is best to restart the trader after so that it picks up the new balances.
  * It is never a good idea to use 100% of your balance for a single trade. The rule of thumb is about 10%, but you can choose higher or lower depending on your preferred level of risk. The calculated PnL that is displayed on the NBT Hub does not take into consideration the trade quantities. So a strategy with a reported PnL of 500% would only increase your balance by a maximum of 50% if you set the trade quantity to 10%.
* ***CONFIG:* Funding / Auto-Balancing for LONG Trades**
  * Several options are now available for choosing where the funds come from for LONG trades. Please make sure you fully understand the implications of these before using them, as they can provide greater gains but can also cause greater losses. I encourage you to take a look at the code and understand the decisions that are being made by each model.
    * **(Default)**: This will use the available funds in margin or spot wallets, and will stop opening new trades when funds run out (low risk).
    * **Borrow Minimum**: This will use the available funds in margin or spot wallets, and will then start borrowing funds in margin to execute new trades (medium risk).
    * **Borrow All**: This will always borrow funds in margin to execute new trades regardless of available funds (high risk).
    * **Sell All**: This will use the available funds in margin or spot wallets, then re-sell a small portion of every active trade in order to free up funds for the new trades. The aim is to get all active trades to have the same investment. E.g. 4 active trades will use 25% of your balance each, if a 5th trade opens then it will sell a portion from the previous 4 so that all 5 trades are using 20% of your balance. However, once trades start to close it will not re-buy the remaining open trades, so this can result in some variation over time.
    * **Sell Largest**: This will use the available funds in margin or spot wallets, then re-sell half of the largest trade. E.g. (assuming you set the fraction quantity to 1) 1st trade will use 100% of your balance, the 2nd trade will sell 50% of the first trade and use that, the 3rd trade will sell 50% of the first trade so now you have 1st @ 25%, 2nd @ 50%, 3rd @ 25% of your total balance. The difference between this and the "All" model is that it only re-sells from a single existing trade whenever a new one comes in. This means that sometimes the trade sizes will not be equal. This also will not re-buy for remaining open trades.
    * **Sell Largest PnL**: This works much the same as **Sell Largest** above, but instead of taking the trade with the largest cost it will try to find a large trade with the best change in price (profit or loss) since it was opened. This gives some of the losing trades more time to recover before selling. It will only consider trades whose cost is above the average, this means only half the active trades can be considered, but often it is less depending on how many larger vs. smaller trades there are. The disadvantage over the simple **Sell Largest** option is that there will be a slighly longer delay, as it needs to retrieve the current prices before making a decision.
  * If a trade has been manually stopped, it will not be touched by the **Sell All**, **Sell Largest**, or **Sell Largest PnL** options.
  * Each model will first attempt to use the "Quantity to spend per trade" from the NBT Hub (either as an absolute or a fraction), this will represent the largest possible trade value. Only if there are insufficient funds, then it will apply one of the options or reduce the trade quantity.
  * Only LONG trades consume your available balance (all SHORT trades are funded through borrowing up to your maximum limit).
* ***CONFIG:* Prevent Losses for Auto-Balancing**
  * This can only be enabled if using one of the **Sell All**, **Sell Largest**, or **Sell Largest PnL** funding models above. Before choosing which LONG trade(s) to sell it will check the current price on Binance and try to determine which trades would make a loss if they were to be sold now. Any losing trades will be excluded from the auto-balancing logic. This means that if all open trades are losing then it will not sell anything and therefore may not be able to open the new trade, or it may only be able to use the free balance. It could also repeatedly sell the same trade on multiple open signals if that is the only trade currently in profit.
  * Therefore the benefit is that this will minimise losses from auto-balancing, but the downside is that it will limit the opportunities for new trades to open during peak periods, and may result in disproportionate trade sizes.
  * The profit and loss calculation is done with the current ticker price, not the actual market bid price, plus there is always risk of slippage. So there may still be some minor losses due to variation in the actual sell price.
* ***CONFIG:* Repay Loan Interest**
  * Before repaying a margin loan the trader will check your current BNB margin balance info to see how much interest has been accumulated. It will then use your BNB to repay that interest first before repaying the principal loan. Obviously you will need to periodically top up your BNB balance to cover the interest repayments.
  * For this to work properly you need to enable the "Using BNB For Interest" option in your margin wallet in Binance. This means that regardless of what coin is borrowed, it will always accumulate the interest as BNB.
  * If there are multiple open trades with borrowed funds, when the first one closes it will repay all the interest accumulated from all loans, so then the next trade to close will only have to repay anything new.
  * Be aware that because the interest is accrued and repaid in BNB only, it will affect the calculated PnL that is displayed in the **Web Diagnostics**. Interest accrued from other coins will not be reflected in their own PnL, and if you have a strategy that accumulates BNB then it will have a lower PnL as a result of all interest.
* ***CONFIG:* Primary Wallet**
  * You can choose whether to use the spot or margin wallet as your primary wallet for LONG trades. It will also use the total balance from this primary wallet to calculate the size of SHORT trades if you are using **Quantity as Fraction**.
  * The default is margin.
* ***CONFIG:* Wallet Buffer**
  * As slippage, spread, and bad trades are difficult to predict, it is good to keep some additional funds in your wallet to cover these costs. You can specify a buffer amount as a fraction of your wallet which will not be used for opening LONG trades.
  * The default is 0.02 which is 2%.
* ***CONFIG:* Maximum Count of Trades**
  * You can set maximum counts for SHORT and for LONG trades to limit how many can be active at one time. This can be used to limit your exposure to risk when borrowing, or to limit the number of times a LONG trade gets rebalanced. If a trade is stopped it will not count towards the limit.
  * The defaults are zero, which is unlimited.
* ***CONFIG:* Disable SHORT Trades**
  * Because SHORT trades will always borrow the full amount of the trade, you can choose to ignore SHORT trades to prevent borrowing.
  * You can still choose to allow borrowing for LONG trades using one of the borrow funding options above.
* ***CONFIG:* Disable Margin Trades**
  * This will prevent any trades from executing on your margin wallet. All LONG trades will then execute on spot, and SHORT trades will be disabled as a result.
  * Even if a LONG trade is executed on your margin wallet it will not borrow any funds by default. You would have to choose one of the borrow funding options above.
* ***CONFIG:* Disable Coins**
  * You can provide a comma delimited list of coins that you want to ignore trade signals for (e.g. DOGE).
* ***CONFIG:* Strategy Loss Limit**
  * You can set a limit on the number of sequential losses for a strategy. If this many losing trades occur for a strategy then that strategy will be stopped. The trader will ignore all open signals for that strategy, and will only process close signals if the price is better (i.e. higher than the open price for LONG trades and lower for SHORT trades). You can still manually close the trades regardless of the price.
  * Stopping and resuming the strategy via the **Web Diagnostics** will reset the count of losing trades, toggling the trade option via the NBT Hub will also reset the count.
  * The default is zero, which is unlimited.
* ***CONFIG:* Strategy Loss Limit Threshold**
  * Used in conjunction with the **Strategy Loss Limit** this allows early limiting of open trades before stopping the strategy completely. If the threshold of losing trades is reached, then new open signals will only be allowed if the count of losses plus the count of open trades is below the loss limit. Essentially this tries to limit the number of open trades so that if they all closed for a loss then it would not exceed the loss limit. But because this only activates when the threshold of losing trades is hit, it is still possible to exceed the loss limit if many open signals came in before the threshold was reached.
  * The threshold is set as a decimal fraction of the loss limit. For example, if the loss limit was 10 and the threshold was 0.4 then it would only activate when there were 4 losses in a row. Before 4 losses, trading would be normal with no limit on open trades. But once it hits 4 losses then the trader would only allow 6 more trades. If there were 4 losses in a row but already 3 open trades, only 3 more open signals would be allowed through for that strategy, to try to limit the potential run of losses to 10. If any one of those trades closed for profit then everything would reset and all new open signals would be accepted.
  * The default is 0.5, set it to 1 to disable, or 0 to essentially have a fixed trade count per strategy.
* ***CONFIG:* BNB Free Threshold**
  * After a trade is closed it will check your remaining BNB balance and generate a warning if it has dropped below this threshold. This helps you to manage your BNB balance so that there are always sufficient funds to cover fees and interest. These warnings will be displayed in the log and also sent using the notification systems. It will check the spot and margin wallets independently.
  * The default is 0.04 BNB, you can set it to 0 if you only want a warning when it is completely empty, or -1 to disable the check.
* ***CONFIG:* BNB Free Top Up Float**
  * You can set a float level for your free BNB balance, then once your BNB balance drops below this level you can use the top up feature on the PnL Web Diagnostics page. This will convert the chosen coin to BNB to increase the free balance to the float level. There are separate buttons for each wallet.
  * It is better to use this option rather than converting manually through Binance so that the trader can adjust the PnL for the change in balance. It does this by offsetting the fees in the balance history.
  * BNB top ups will not appear in the transactions list.
  * The default is 0.1 BNB, you can set it to 0 if you do not want to allow the top up feature.
* ***CONFIG:* BNB Free Auto Top Up**
  * If you do not want to manually top up the BNB you can set a chosen coin (e.g. BTC) to always use for topping up. If set, this will automatically attempt to purchase BNB using the specified coin and restore the balance to the **Top Up Float** as soon as the balance drops below the **Threshold**.
  * If it succeeds or fails the result will be logged and a notification will be sent.
  * The default is blank, which is disabled.
* ***CONFIG:* Estimated Taker Fee**
  * In a typical setup, fees are charged in BNB, therefore they do not affect the balance of the coin used for funding the strategy. So in order to make the calculated PnL more accurate, the estimated fees are calculated based on the spot wallet Taker Fee percentage. It does not currently calculate the interest charged on margin lending.
  * Unlike other settings, this is represented as a percentage and not a decimal fraction. This means you can just copy and paste the fee directly from Binance.
  * The default is 0.075(%). If you have a higher VIP level or rebate on Binance that entitles you to lower fees, you can modify the Taker Fee percentage within the trader to match.
* ***CONFIG:* Minimum Trade Cost Buffer**
  * Sometimes it is possible to get a MIN_NOTIONAL error from Binance if the trade cost is too small. Even though the trader attempts to round up to the minimum cost, slippage in the price can still cause it to fail. So a buffer is used to increase the minimum cost to attempt to avoid this error.
  * The default is 0.2, which is 2% of the minimum cost as defined by Binance.
* ***CONFIG:* Virtual Wallet Funds**
  * You can set a default balance for virtual trades, this allows you to simulate some of the auto-balancing or funding models above. The value represents roughly the equivalent BTC amount. For example, if you set the funds to 1 but you are trading in USDT, it will use the minimum purchase volumes to estimate a 'similar' USDT value of 1 BTC as the starting balance. This is not current market price, it is just a pre-determined scale set by Binance.
  * The default is 0.1 BTC which (at the time of writing) converts to 10,000 USDT.
* **Alternate Wallet Fall Back**
  * If you do not have sufficient funds in your primary wallet (e.g. margin) to make LONG trades, it will automatically try to make the trade from your other wallet (e.g. spot).
* **Database Backup**
  * If configured, it will save the current state of strategies, open trades, virtual balances, and balance history to a Postgres database. It will also save internal logs and transaction history, but with a limit on the total number of records. If the trader restarts it will first attempt to load the previous state of the strategies, open trades, virtual balances, and balance history from the database. It will still read the strategies and trades from the NBT Hub and compare them to the reloaded data, if there are any discrepancies then it will report this in the logs.
  * When deployed on Heroku it will automatically provision a free dev database, which has a limit of 10,000 records. It will automatically delete some of the oldest logs or transactions if the total number of records reaches this limit.
  * If you are concerned that the data in the database is out of sync with the NBT Hub then you can just reset the database (there is a button in Heroku to do this). This will then load the strategies and open trades from the NBT Hub and clear other history. If rebalancing has occurred on open trades it will make its best guess as to what these should be based on the current balances in Binance.
* **Web Diagnostics**
  * You can connect to the trader webserver to view the internal information that is being tracked (e.g. http://localhost:8003/log). The following commands are available:
    * **/log** - Internal log currently held in memory (newest entries at the top).
    * **/log?db=1** - Internal log loaded from the database (newest entries at the top).
    * **/pnl** - Calculated rate of return and history of open and close balances (best estimation based on available data).
    * **/pnl?reset=** - Specify a coin and trading type to clear the Balance History and PnL for that coin and type (e.g. ?reset=BTC:real).
    * **/pnl?topup=** - Specify a coin and wallet to buy BNB to top up the float (e.g. ?topup=BTC:spot).
    * **/strategies** - Configured strategies.
    * **/strategies?stop=** - Specify a strategy ID to shut down trading, this will still allow open trades to close automatically but only when the signal price is a profit.
    * **/strategies?start=** - Specify a strategy ID to resume normal trading.
    * **/strategies?public** - List of all strategies broadcasting public signals since the trader started.
    * **/trades** - Current open trades list.
    * **/trades?hodl=** - Specify a trade ID to HODL, this will only accept a close signal when the price will result in a profit.
    * **/trades?release=** - Specify a trade ID to release the HODL status, this will accept the next close signal from the NBT Hub.
    * **/trades?stop=** - Specify a trade ID to stop trading, this will keep the trade open but ignore close signals from the NBT Hub.
    * **/trades?start=** - Specify a trade ID to resume trading, this will accept the next close signal from the NBT Hub.
    * **/trades?close=** - Specify a trade ID to attempt to close the trade on Binance. You may need to use this if the trader gets out of sync with the NBT Hub.
    * **/trades?delete=** - Specify a trade ID to delete the trade without closing it. This will not remove the trade from the BVA Hub, so you may have to do that separately. It also will not modify the virtual balances nor close the trade on Binance, so this will probably throw out the PnL calculations as it will seem like there was a significant change in the closing balance. You may want to use one of the 'reset' commands to start fresh.
    * **/trans** - Log of actual buy, sell, borrow, repay transactions held in memory (newest entries at the top).
    * **/trans?db=1** - Log of actual buy, sell, borrow, repay transactions loaded from the database (newest entries at the top).
    * **/virtual** - Views the current virtual balances.
    * **/virtual?reset=true** - Clears and reloads the virtual balances and virtual PnL. You can also pass a number on the reset and it will change the default value for **Virtual Wallet Funds** (e.g. ?reset=100).
    * **/graph.html?summary=** - Specify coin and trading type to graph the last 7 days worth of transactions (e.g. ?summary=BTC:real).
  * You can also configure a **Web Password** in the environment variables to restrict access to these commands (e.g. http://localhost:8003/log?mypassword).
* **HODL Open Trades**
  * Using the feature in the **Web Diagnostics** above you can select individual trades to enable HODL (Hold On for Dear Life). Unlike a stopped trade, a HODL trade can still close automatically from a signal but only if the price will result in a profit. HODL can be set on individual trades without having to stop the strategy.
  * By default a HODL trade will not be used for auto-balancing, but if you have enabled the **Prevent Losses for Auto-Balancing** option then a HODL trade may be used once the price is in profit.
* ***CONFIG:* Automatically Close HODL Trades**
  * If enabled, the trader will periodically check the current price of any trades that are set to HODL, or any trades that belong to a strategy that has been stopped (shut down), and will automatically close any trades that are expected to make a profit. The trader does not do a trailing stop loss, so it will close the trade the first time it detects a profit. This will likely mean that the profit will be minimal, and may even make a small loss if slippage occurs. However, the benefit is that it will close the trades at the earliest opportunity rather than waiting for the original strategy to send another close signal.
  * By default this option is disabled. When enabled it will check the latest prices as part of the background process, which is currently on a five minute interval.
* **Individual Tracking of Real / Virtual Trades**
  * In the original trader if you started a strategy in virtual trading and switched to real trading, or vice versa, it would attempt to close trades based on the current status of the strategy, rather than how the trade was originally opened. This means it could try to close a trade on Binance that was originally opened virtually, or never close the open trade on Binance because you've now switched the strategy to virtual. Now, if the trade opened on Binance it will close on Binance even if the strategy has been switched to virtual. If you don't want this to happen, make sure you close or stop the open trades before switching modes.
  * This is a useful way to soft close a strategy. Rather than manually closing the live trades yourself, you can switch the strategy to virtual and wait for the automatic close signals for any remaining open trades.
* **Clean Up Stopped Trades**
  * If you stop a trade on the NBT Hub then manually close it, first it will actually try to close the trade on Binance, but if that fails it will still respond to the NBT Hub with a close signal so that the open trade does not hang around forever. This is important for the calculations used in the auto balancing, as they rely on the current list of open trades. So if you want to purge a stopped trade like this, first make sure you have moved any funds from Binance so that it cannot execute the close.
  * Previously you could switch a strategy to virtual then close the trade, but as mentioned above each trade now remembers its original state, so a live trade will remain live even if you switch the strategy to virtual.
  * Also, if there are any issues loading previous open trades after a restart the trader will say these are discarded. But if you manually close one of these trades it will just notify the BVA Hub that the close was successful to clean it up. It will not attempt to buy or sell anything on Binance.
* **Compare Open Trades to Strategy**
  * Sometimes it is possible to miss a closing trade signal, such as if there are connection issues or your trader is offline. So whenever the trader establishes a connection with the NBT Hub it will compare the current open trades on the trader with the expected open trades for the strategy. If any have been closed by the strategy it will log a warning and send a notification. You can then decide if you want to manually close those trades.
  * If you want to force the trader to do a comparison you can also just toggle or change something on the favourite strategies page on the NBT Hub. Comparisons will not be done for strategies or trades that are stopped.
* **Track Order Price / Cost**
  * When a real trade is successfully executed on Binance the actual buy or sell price and cost will be saved from the response. These prices and cost will be reported in the notifications and transactions, as well as used for calculating the closing balances for the PnL. This can be useful if you want to get a better idea of slippage.
* **Validate Filled Quantity**
  * If you have run out of BNB to cover trading fees then Binance will deduct the fees from the trade quantity, which means the quantity availale to close the trade will not match the expected opening quantity. The trader will now detect this on buy orders and will adjust the trade quantity or borrow amount so that the trade can still be closed.
  * When this occurs it will likely mean a discrepancy in the quantity in Binance so you will need to clean it up manually. For LONG trades you will need to use the "Convert Small Balance to BNB" option to convert the remainder. For SHORT trades you will need to manually buy the minimum amount and pay off the loan, then convert the remainder to BNB.
  * An error will be reported in the log and a notification message will be sent (if enabled) that will show the original and adjusted amounts.
  * It is strongly recommended that you keep your BNB topped up to avoid this situation.
* **Additional Notifications**
  * If a trade fails to execute it will now send a notification with the error message.
  * If there are any issues loading previous trades after the trader restarts it will now send a notification message.
  * Trade notifications now include the quantity, cost, borrowed amount, wallet, trading type (live or virtual), and actual buy and sell prices from the transaction.
* ***CONFIG:* Notification Level Filter**
  * If you are happy to monitor the status of your trades in the Web Diagnostics but want to receive notifications when something goes wrong, you can now change the Notifier Level in the settings to limit the types of messages that are sent by the notification system.
  * The default is 'info' which allows all, but can be changed to 'success', 'warn', or 'error'. 
* ***CONFIG:* Short Notification Messages**
  * Enabling this setting will reduce the notification messages to only show basic details about the trade or signal, such as the cost, percentage change in price, and duration. This can be useful when using Telegram, as the key information will be visible in the message popup.
* ***CONFIG:* Additional Logging**
  * By default the trader will only log 'info', 'warn', and 'error' messages. But there is an internal setting to change the logging level to 'debug' if you want more insight into what decisions the trader is making. You can even drop the level to 'silly' to see all incoming JSON messages and SQL statements.
  * If you have the database backup enabled then it will keep the logs in the database, but only the original 'info', 'warn', and 'error' messages will be saved to minimise space. If you enable the other levels they will only be held in memory while the trader is running, and can be viewed via the web diagnostics interface.
* **Comments**
  * I've added extensive comments to the trader.ts code to (hopefully) help you understand how it works. But please feel free to find me on Discord if you have any questions.

See the **[Quick start guide 🚀](./docs/GETTING-STARTED.md)** for instructions on configuring any of these options.

## Table of contents

1. **[Documentation 📖](#documentation)**
1. **[Technical overview 👨‍💻](#technical-overview)**
1. **[Disclaimer 📖](#disclaimer)**
1. **[Donate 🙏](#donate)**
1. **[Getting in touch 💬](#getting-in-touch)**
1. **[Final Notes](#final-notes)**

## Documentation

- **[Quick start guide 🚀](./docs/GETTING-STARTED.md)**: bootstrap using Heroku
- **[Manual setup guide 👨‍💻](./docs/GETTING-STARTED-MANUALLY.md)**: bootstrap using your own client
- **[Web socket API specification 📡](./docs/WEB-SOCKET-API-SPECIFICATION.md)**

## Technical overview

<img src="docs/images/nbt_diagram.png">

NBT includes 3 main scripts:

> NOTE: If you are a first-time user and you just want to follow the existing strategies on [Bitcoin vs. Altcoins](https://bitcoinvsaltcoins.com), all you need to worry about is the **trader** script. Just follow the **[Quick start guide 🚀](./docs/GETTING-STARTED.md)** to deploy the **trader** on Heroku. The **server** and **backtest** scripts are only needed if you want to start creating your own strategies.

* the **trader**: [![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/PostmanSpat/node-binance-trader)

  * this script allows you to auto trade the signals received from the NBT hub or your own server. this script can run locally or on cloud services like Heroku. This new auto trader script allows you to trade with leverage when the pair is available for margin trading.

* the **server**:

  * to track a selection of asset pairs and record all [Binance](https://www.binance.com/en-AU/register?ref=141340247) api data (candles, depths, trades) into a Postgres database.
  * to detect buy or sell signals
  * (optional) to send trading signals to the NBT Hub / [Bitcoin vs. Altcoins](https://bitcoinvsaltcoins.com) to monitor performances and auto trade those signals (virtually or for real).

* the **backtest**:

  * to backtest your strategies on the historical tick data (Postgres database) recorded by the server.

## Disclaimer

> No owner or contributor is responsible for anything done with this bot.
> You use it at your own risk.
> There are no warranties or guarantees expressed or implied.
> You assume all responsibility and liability.

## Donate

**Donations for Spat**

If you like my fork you can always leave me a tip:
* BNB (ERC20) 0xbb2f5e8b145a3c96512b4943d88ed62487f49bff
* USDT (TRC20) TUG5A6oaQZCu2pS33sTyfrgf17ejkYH644
* BTC 1L2NZPK8s7otCHJnn3KHQLfWrL6NUe1uwc

**Donations for herve76 (original creator)**

Refer to [source repo](https://github.com/jsappme/node-binance-trader) for latest donation options.

## Getting in touch

* **Discord**: [Invite Link](https://discord.gg/4EQrEgj)

<p align="center">
  <a href="https://discord.gg/4EQrEgj"><img alt="Discord chat" src="docs/images/discord_button.png" /></a>
</p>

## Final Notes

Feel free to fork and add new pull request to this repo.
If you have any questions/suggestions, or simply you need some help building your trading bot, or mining historical data or improving your strategies using the latest AI/ML algorithms, please feel free to <a href="mailto:herve76@gmail.com" target="_blank">contact herve76</a>.