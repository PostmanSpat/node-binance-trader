import BigNumber from "bignumber.js"
import { Balances, Dictionary, Market, Order } from "ccxt"
import PQueue from "p-queue"
import crypto from "crypto"
import { v4 as uuidv4 } from 'uuid'

import logger from "../logger"
import {
    amountToPrecision,
    createMarketOrder,
    fetchBalance,
    fetchTicker,
    getMarginLoans,
    loadMarkets,
    loadPrices,
    marginBorrow,
    marginRepay
} from "./apis/binance"
import { getStratTradeOpenList, getTradeOpenList } from "./apis/bva"
import { initialiseDatabase, loadObject, saveObjects, saveRecord } from "./apis/postgres"
import env from "./env"
import startWebserver from "./http"
import initializeNotifiers, { getNotifierMessage, notifyAll } from "./notifiers"
import socket from "./socket"
import { LoanTransaction } from "./types/binance"
import {
    EntryType,
    PositionType,
    PublicStrategy,
    Signal,
    SignalJson,
    Strategy,
    StrategyJson,
    TradeOpen,
    TradingType,
} from "./types/bva"
import { MessageType } from "./types/notifier"
import { WalletType, TradingData, TradingMetaData, TradingSequence, LongFundsType, WalletData, ActionType, SourceType, Transaction, BalanceHistory } from "./types/trader"

// Standard error messages
const logDefaultEntryType = "It shouldn't be possible to have an entry type other than enter or exit."
const logDefaultPositionType = "It shouldn't be possible to have an position type other than long or short."
const logTradeOpenNone = "Skipping signal as there was no associated open trade found."

// Changes to true after strategies and trades have been processed
let isOperational = false

// Holds the information about the current strategies and open trades
export const tradingMetaData: TradingMetaData = {
    strategies: {}, // This comes from the payload data that is sent from NBT Hub, it is a dictionary of type Strategy (see bva.ts) indexed by the strategy ID
    tradesOpen: [], // This is an array of type TradeOpen (see bva.ts) containing all the open trades
    tradesClosing: new Set(), // List of open trades that are currently in the processing queue and have not been executed on the Binance exchange, this includes rebalancing
    markets: {}, // This is a dictionary of the different trading symbols and limits that are supported on the Binance exchange
    prices: {}, // This is a dictionary of the current prices for each symbol, note this is not specifically the buy or sell prices
    virtualBalances: {}, // The virtual wallets used to keep track of the balance for simulations
    transactions: [], // Array to keep a transaction history
    balanceHistory: {}, // Keeps the open and close balances over time for each quote coin, indexed by trading type then coin
    publicStrategies: {}, // Keeps track of all strategies sending public signals
}

// Used for initialising and resetting the virtual balances
let virtualWalletFunds = new BigNumber(env().VIRTUAL_WALLET_FUNDS) // Default to environment variable, but can be changed later
export function setVirtualWalletFunds(value: BigNumber) { virtualWalletFunds = value }

// Set of object names from the tradingMetaData that have recently been modified
const dirty = new Set<keyof typeof tradingMetaData>()

// Configuration for the asynchronous queue that processes signals and executes the trades on Binance
const queue = new PQueue({
    concurrency: 1,
    interval: 250,
})

// Receives the information on selected strategies from the NBT Hub
export async function onUserPayload(strategies: StrategyJson[]) {
    try {
        // Convert list of strategy IDs into a comma delimited string for logging
        const strategyIds = strategies
            .map((strategy) => strategy.stratid)
            .join(", ")
        logger.info(
            `Received ${strategies.length} user strategies${
                strategyIds && ": " + strategyIds
            }.`
        )

        // Log if any are not yet configured
        // These have to be ignored because we don't know whether the trades were real or virtual
        const invalid = strategies.filter(s => new Strategy(s).tradingType == undefined)
        if (invalid.length) {
            logger.warn(`There are ${invalid.length} strategies that have not yet been configured, so will be ignored: ${invalid.map(s => s.stratid).join(", ")}.`)
        }

        // Users may set the trade amount to zero to prevent the strategy from opening new trades, but they still want it to close existing trades normally
        const zero = strategies.filter(s => s.buy_amount <= 0 && !invalid.includes(s))
        if (zero.length) {
            logger.warn(`There are ${zero.length} strategies that do not have a trade amount configured, these will still accept closing signals but will not open new trades: ${zero.map(s => s.stratid).join(", ")}.`)
        }
        
        // Processes the JSON data into the strategies dictionary (ignoring invalid strategies)
        const newStrategies: Record<string, Strategy> = Object.assign(
            {},
            ...strategies.filter(s => !invalid.includes(s)).map((s) => {
                const strategy = new Strategy(s)
                return {
                    [strategy.id]: strategy,
                }
            })
        )

        // If the trader is not yet operational then load the previous open trades from the NBT Hub
        if (!isOperational) {
            tradingMetaData.tradesOpen = await loadPreviousOpenTrades(newStrategies).catch((reason) => {
                // This will prevent the strategies from being saved too, so this will prevent the trader from functioning until the problem is resolved
                logger.silly("onUserPayload->loadPreviousOpenTrades: " + reason)
                shutDown(reason)
                return Promise.reject(reason)
            })
            saveState("tradesOpen")

            isOperational = true
            logger.info("NBT Trader is operational.")
        }

        // Compare differences with any previous strategies and copy trade flags
        checkStrategyChanges(newStrategies)
        
        // Everything is good to go, so update to the new strategies
        tradingMetaData.strategies = newStrategies
        saveState("strategies")

        // Compare the open trades for each strategy to see if they have been closed on the NBT Hub
        compareStrategyTrades()
    } catch (reason) {
        shutDown(reason)
        return Promise.reject(reason)
    }
}

// Retrieves the open trade list from the NBT Hub then tries to match them to existing balances and loans in Binance.
async function loadPreviousOpenTrades(strategies: Dictionary<Strategy>): Promise<TradeOpen[]> {
    // Retrieve the existing open trades from the NBT Hub
    let prevTrades = await getTradeOpenList().catch((reason) => {
        logger.silly("loadPreviousOpenTrades->getTradeOpenList: " + reason)
        return Promise.reject(reason)
    })

    // Keep track of any trades that can't be processed
    const badTrades: TradeOpen[] = []

    // If there are already open trades then they must have been restored from the database
    if (tradingMetaData.tradesOpen.length) {
        // Compare the restored trades to what we have just received
        let same = tradingMetaData.tradesOpen.length == prevTrades.length

        // Check the received trades exist in the db
        for (const prevTrade of prevTrades) {
            const tradeOpen = getTradeOpen(prevTrade)
            if (tradeOpen) {
                // As the real trade ID is not used for anything at the moment, we'll just keep the one we generated for consistency in the transactions
                /*if (tradeOpen.id != prevTrade.id) {
                    // We don't get the trade ID when the trade was opened normally, so it is likely to change after a restart
                    logger.debug(`Trade ID ${tradeOpen.id} changed to ${prevTrade.id}.`)
                    tradeOpen.id = prevTrade.id 
                }*/

                // The trade may have stopped previously due to the trader logic that the NBT Hub doesn't know about
                // But there is a chance that the user stopped the trade while the trader was offline, so we'll take the new state
                if (!tradeOpen.isStopped && prevTrade.isStopped) {
                    logger.warn(`${getLogName(tradeOpen)} trade has now been stopped.`)
                    tradeOpen.isStopped = prevTrade.isStopped
                }
            } else {
                logger.error(`${getLogName(prevTrade)} trade was not found in the database, it will be discarded.`)
                badTrades.push(prevTrade)
                same = false
            }
        }

        for (const dbTrade of tradingMetaData.tradesOpen) {
            // Check the db trades exist in what was received
            if (!getTradeOpenFiltered(dbTrade, prevTrades).length) {
                // Check that the trade actually executed before the trader restarted
                if (!dbTrade.isExecuted) {
                    logger.error(`${getLogName(dbTrade)} trade did not execute, it will be discarded.`)
                    badTrades.push(dbTrade)
                } else {
                    logger.error(`${getLogName(dbTrade)} trade is missing from the NBT Hub, it will remain until the next exit signal.`)
                    same = false
                }
            } else if (!dbTrade.isExecuted) {
                // There might be a rare case where the trader crashed before it could record the state of the trade, but the trade still executed and sent the signal to the hub
                logger.warn(`${getLogName(dbTrade)} trade did not record as executed, but it was found on the NBT Hub, so it must be ok.`)
                // Just have to assume it all went through ok, so we'll update the state
                dbTrade.isExecuted = true
            }
        }

        if (!same) {
            logger.error(`The list of open trades loaded from the NBT Hub does not match what was reloaded from the database, so the list from the database will be used. If there are discarded trades then you can close them on the NBT Hub, for missing trades you can wait for the next exit signal and the trade will close normally or delete them from the Open Trades list, otherwise you can clear the database and restart the trader to resync with the NBT Hub.`)
        }

        // Use what was loaded from the database because this will have accurate funding and balancing, not what was received from the NBT Hub
        // Most of the bad trades won't be in the db list anyway, but there is a case for non-executed that need to be removed
        prevTrades = tradingMetaData.tradesOpen.filter(trade => !badTrades.includes(trade))
    } else {
        // Make sure trades are valid for loading
        // We didn't check this above because we could still close the trade if it was loaded from the database
        for (let trade of prevTrades) {
            // Check that all the previous open trades match to current strategies
            if (trade.strategyId in strategies) {
                // There is no way to know how the trade was previously opened, so have to assume it is still the same as the current strategy
                trade.tradingType = strategies[trade.strategyId].tradingType
            } else {
                // There is no way to guess if it was previously real or virtual
                logger.error(`${getLogName(trade)} trade is no longer associated with any strategies, it will be discarded.`)
                badTrades.push(trade)
                continue
            } 

            switch (trade.positionType) {
                case PositionType.SHORT:
                    if (!trade.priceSell) {
                        // Hopefully this won't happen
                        logger.error(`${getLogName(trade)} trade is missing a sell price, it will be discarded.`)
                        badTrades.push(trade)
                        continue
                    }
                    break
                case PositionType.LONG:
                    if (!trade.priceBuy) {
                        // Hopefully this won't happen
                        logger.error(`${getLogName(trade)} trade is missing a buy price, it will be discarded.`)
                        badTrades.push(trade)
                        continue
                    }
                    break
            }

            if (!tradingMetaData.markets[trade.symbol]) {
                // Hopefully this won't happen often
                logger.error(`${getLogName(trade)} trade symbol is no longer supported on Binance, it will be discarded.`)
                badTrades.push(trade)
                continue
            }
        }

        // Remove bad trades so that they don't get considered for balance allocation
        prevTrades = prevTrades.filter(trade => !badTrades.includes(trade))

        // NBT Hub is not aware of the funding and balancing models, so we need to try to match these trades to Binance balances to estimate the remaining trade quantities and costs
        // Start by loading the current balances for each wallet
        const balances: Dictionary<Balances> = {}
        for (const wallet of Object.values(WalletType)) {
            balances[wallet] = await fetchBalance(wallet).catch((reason) => {
                logger.silly("loadPreviousOpenTrades->fetchBalance: " + reason)
                return Promise.reject(reason)
            })
        }
        
        // Get current loans so we can match SHORT trades or borrowed LONG trades
        const marginLoans = getMarginLoans(balances[WalletType.MARGIN])    // Can only match real trades to balances, virtual balances will have reset
        
        const realTrades = prevTrades.filter(trade => trade.tradingType == TradingType.real)
        const virtualTrades = prevTrades.filter(trade => trade.tradingType == TradingType.virtual)

        if (realTrades.length) {
            // Potentially there can be multiple trades for the same coins from different strategies, so need to work out what the maximum allocation is
            // First lets start with SHORT trades, because the loans are less obscured
            const borrowed: Dictionary<BigNumber> = {}
            for (let trade of realTrades.filter(t => t.positionType == PositionType.SHORT)) {
                const market = tradingMetaData.markets[trade.symbol]
                if (!borrowed[market.base]) borrowed[market.base] = new BigNumber(0)
                borrowed[market.base] = borrowed[market.base].plus(trade.quantity)
            }

            // It may be possible for both a SHORT trade and a LONG trade to borrow the same asset, so the SHORT trade will get it first
            for (let trade of realTrades.filter(t => t.positionType == PositionType.SHORT)) {
                const market = tradingMetaData.markets[trade.symbol]

                // All SHORT trades are from margin
                trade.wallet = WalletType.MARGIN

                // As SHORT trades can't be rebalanced, the original quantity should be correct, so calculate cost and borrow
                trade.cost = trade.quantity.multipliedBy(trade.priceSell!)
                trade.borrow = trade.quantity

                // Now we need to take these funds away from the balances, because they can't be used for LONG trades
                // For example if you had a SHORT trade on ETHBTC and a LONG trade on BTCUSD, these would share the same balance
                balances[trade.wallet][market.quote].free -= trade.cost.toNumber()
                marginLoans[market.base].borrowed -= trade.borrow.toNumber()

                if (balances[trade.wallet][market.quote].free < 0) {
                    logger.error(`Insufficient funds in ${market.quote} ${trade.wallet} wallet, you might not be able to repay ${getLogName(trade)} trade.`)
                    balances[trade.wallet][market.quote].free = 0
                }

                // Check if we will pay back too much
                if (marginLoans[market.base].borrowed < 0) {
                    // Take off the difference
                    trade.borrow = trade.borrow.plus(marginLoans[market.base].borrowed)
                    marginLoans[market.base].borrowed = 0
                    logger.error(`Loaned amount for ${market.base} doesn't match open short trades, reducing the repayment amount for ${getLogName(trade)} trade.`)
                }
            }

            // We're going to hope that the trades haven't been rebalanced, so we'll try to assign the original quantity to wallets first
            // If there is only one trade in each coin, then it should match up well
            // But if there are multiple trades sharing the same coin, and they have been rebalanced, we have to assume that they were about even
            // So we may not always get back to exactly the same state as before the restart, but it should be close enough
            const wallets: Dictionary<Dictionary<WalletData>> = {}
            for (let trade of realTrades.filter(t => t.positionType == PositionType.LONG)) {
                const market = tradingMetaData.markets[trade.symbol]
                // Get the list of wallets that could have been used for this trade
                const {preferred, primary} = getPreferredWallets(market, trade.positionType)
                
                // Calculate the potential funds that could be used for this trade in each wallet
                for (const w of preferred) {
                    if (!wallets[market.base]) wallets[market.base] = {}
                    if (!wallets[market.base][w]) {
                        wallets[market.base][w] = new WalletData(w)
                        wallets[market.base][w].free = new BigNumber(balances[w][market.base].free)
                        wallets[market.base][w].potential = wallets[market.base][w].free

                        logger.debug(`${w} wallet has ${wallets[market.base][w].free.toFixed()} ${market.base} free.`)
                    }

                    // If there is enough free balance, then use that as the potential
                    wallets[market.base][w].potential = wallets[market.base][w].free.minus(wallets[market.base][w].total)
                    if (wallets[market.base][w].potential!.isLessThan(trade.quantity)) {
                        // Otherwise use equal portions of the balance for each trade
                        wallets[market.base][w].potential = wallets[market.base][w].free.dividedBy(wallets[market.base][w].trades.length + 1)
                    }
                }
                
                // Use the preferred wallet or the one with with the best potential
                const wallet = getBestWallet(trade.quantity, preferred, wallets[market.base])
                
                // Assign this trade to the wallet and update the total and count
                trade.wallet = wallet.type
                wallet.total = wallet.total.plus(trade.quantity) // Will be rebalanced later
                wallet.trades.push(trade)
            }

            // Recalculate to an average quantity if the total is more than the free balance
            for (let coin of Object.keys(wallets)) {
                for (let walletType of Object.keys(wallets[coin])) {
                    const wallet = wallets[coin][walletType]
                    if (wallet.total.isGreaterThan(wallet.free)) {
                        // Each coin pair may have a different minimum quantity, so have to calculate the actual quantity per trade
                        // Also, we will update the free balance as each quantity is consumed, so remember the target now
                        const target = wallet.free.dividedBy(wallet.trades.length)
                        logger.info(`Insufficient ${coin} in ${walletType}, reducing ${wallet.trades.length} trades to about ${target} ${coin}.`)
                        logger.debug(`Needed ${wallet.total.toFixed()} but only have ${wallet.free.toFixed()}.`)

                        // Find all LONG trades that share this coin and wallet
                        for (let trade of realTrades.filter(t =>
                            t.positionType == PositionType.LONG &&
                            t.wallet == walletType &&
                            tradingMetaData.markets[t.symbol].base == coin)) {
                                const market = tradingMetaData.markets[trade.symbol]
                                // Try to use the target quantity
                                trade.quantity = getLegalQty(target, market, trade.priceBuy!) // LONG trades will always be buy price
                                trade.timeUpdated = new Date()

                                // Check if we have used more than is available
                                if (trade.quantity.isGreaterThan(wallet.free)) {
                                    trade.quantity = getLegalQty(wallet.free, market, trade.priceBuy!)

                                    if (trade.quantity.isGreaterThan(wallet.free)) {
                                        // Still not enough to make this trade
                                        logger.error(`${getLogName(trade)} trade does not have sufficient funds, it will be discarded.`)
                                        badTrades.push(trade)
                                        // Don't want to subtract the quantity, so skip to the next trade
                                        continue
                                    }
                                }

                                // Track how much has been consumed
                                wallet.free = wallet.free.minus(trade.quantity)
                        }

                        // Make sure that the rebalancing consumed everything
                        if (wallet.free.isGreaterThan(0)) {
                            // Hopefully this is just a rounding issue, but it may be a result of maximum trade sizes too
                            logger.warn(`Rebalancing ${coin} in ${walletType} did not allocate everything to trades, you may need to sell ${wallet.free.toFixed()} ${coin} manually in Binance.`)
                        }
                    }
                }
            }

            // Calculate the cost for LONG trades, it may use the original quantity or new quantity
            for (let trade of realTrades.filter(t => t.positionType == PositionType.LONG)) {
                trade.cost = trade.quantity.multipliedBy(trade.priceBuy!)
            }

            // See if we can mop up any loans with the margin LONG trades
            for (let trade of realTrades.filter(t =>
                t.positionType == PositionType.LONG &&
                t.wallet == WalletType.MARGIN &&
                !badTrades.includes(t))) {
                    const market = tradingMetaData.markets[trade.symbol]
                    if (marginLoans[market.quote] && marginLoans[market.quote].borrowed) {
                        trade.borrow = new BigNumber(marginLoans[market.quote].borrowed)
                        if (trade.borrow.isGreaterThan(trade.quantity)) trade.borrow = trade.quantity
                        marginLoans[market.quote].borrowed -= trade.borrow.toNumber()

                        logger.info(`${getLogName(trade)} trade will repay loan of ${trade.borrow} ${market.quote}.`)
                    }
            }

            // Remove bad trades so that they don't get started
            prevTrades = prevTrades.filter(trade => !badTrades.includes(trade))
        }

        // Better check that all the loans have been allocated to open real trades
        for (let coin of Object.keys(marginLoans).filter(c => marginLoans[c].borrowed)) {
            logger.error(`A margin loan of ${marginLoans[coin].borrowed} ${coin} has not been allocated to any open trades, you will have to repay this manually in Binance.`)
        }

        // Update optional properties for virtual trades, no way of matching the quantity so just use what was sent
        for (const trade of virtualTrades) {
            const market = tradingMetaData.markets[trade.symbol]
            switch (trade.positionType) {
                case PositionType.SHORT:
                    trade.wallet = WalletType.MARGIN
                    trade.cost = trade.quantity.multipliedBy(trade.priceSell!)
                    trade.borrow = trade.quantity
                    break
                case PositionType.LONG:
                    if (!market.margin) {
                        trade.wallet = WalletType.SPOT
                    } else {
                        trade.wallet = env().PRIMARY_WALLET
                    }
                    trade.cost = trade.quantity.multipliedBy(trade.priceBuy!)
                    trade.borrow = new BigNumber(0)
                    break
            }
        }

        // Update virtual balances to match existing trades
        resetVirtualBalances(virtualTrades)

        // Log results
        prevTrades.forEach(trade =>
            logger.info(`Previous trade ${getLogName(trade)} assigned to ${trade.wallet}, quantity = ${trade.quantity.toFixed()}, cost = ${trade.cost?.toFixed()}, borrowed = ${trade.borrow?.toFixed()}.`)
        )
    }

    // Send notifications of discarded trades
    badTrades.forEach(trade => 
        notifyAll(getNotifierMessage(MessageType.WARN, undefined, undefined, trade, "This previous trade could not be reloaded. Check the log for details.")).catch((reason) => {
            logger.silly("loadPreviousOpenTrades->notifyAll: " + reason)
        })
    )

    // Keep the list of trades
    return prevTrades
}

// Compare differences between previously loaded strategy and the new strategies from the payload
function checkStrategyChanges(strategies: Dictionary<Strategy>) {
    // Check if a strategy has moved from real to virtual or vice versa and warn about open trades
    for (let strategy of Object.keys(strategies).filter(strategy =>
        strategy in tradingMetaData.strategies &&
        strategies[strategy].tradingType != tradingMetaData.strategies[strategy].tradingType)) {
            // Find all existing open trades for this strategy that have a different trading type (may have switched then switched back)
            const stratTrades = tradingMetaData.tradesOpen.filter(trade =>
                trade.strategyId == strategy &&
                trade.tradingType != strategies[strategy].tradingType)
            if (stratTrades.length) {
                logger.warn(`Strategy ${strategy} has moved from ${tradingMetaData.strategies[strategy].tradingType} to ${strategies[strategy].tradingType}, there are ${stratTrades.length} open trades that will remain as ${tradingMetaData.strategies[strategy].tradingType} so that they can be closed correctly.`)
            }
    }

    // Check if a strategy has been removed and notify of the paused open trades
    for (let strategy of Object.keys(tradingMetaData.strategies).filter(strategy => !(strategy in strategies))) {
        // Find all existing open trades for this strategy
        const stratTrades = tradingMetaData.tradesOpen.filter(trade => trade.strategyId == strategy)
        if (stratTrades.length) {
            logger.warn(`Strategy ${strategy} has been removed, there are ${stratTrades.length} open trades that will be paused. You can still manually close them in the NBT Hub.`)
            // Send notifications of paused trades
            stratTrades.forEach(trade => 
                notifyAll(getNotifierMessage(MessageType.WARN, undefined, undefined, trade, "The strategy has been removed so this trade will be paused.")).catch((reason) => {
                    logger.silly("checkStrategyChanges->notifyAll: " + reason)
                })
            )
            // Note, we don't actually need to pause the trades as the signals will be ignored for these strategies anyway
        }
    }

    // Check if a strategy has been re-added so notify about resuming the open trades
    for (let strategy of Object.keys(strategies).filter(strategy => !(strategy in tradingMetaData.strategies))) {
        // Find all existing open trades for this strategy
        const stratTrades = tradingMetaData.tradesOpen.filter(trade => trade.strategyId == strategy && !trade.isStopped)
        if (stratTrades.length) {
            logger.warn(`Strategy ${strategy} has been restored, there are ${stratTrades.length} paused trades that will be resumed.`)
            // Send notifications of resumed trades
            stratTrades.forEach(trade => 
                notifyAll(getNotifierMessage(MessageType.WARN, undefined, undefined, trade, "The strategy has been restored so this trade will be resumed.")).catch((reason) => {
                    logger.silly("checkStrategyChanges->notifyAll: " + reason)
                })
            )
        }
    }

    // Copy the stopped flag, count of lost trades, and name because these aren't sent from NBT Hub
    for (let strategy of Object.keys(strategies).filter(strategy => strategy in tradingMetaData.strategies)) {
        // Only if the trade (active) flag has not been switched
        // Toggling the trade flag will reset the stopped status and loss run
        if (strategies[strategy].isActive == tradingMetaData.strategies[strategy].isActive) {
            strategies[strategy].isStopped = tradingMetaData.strategies[strategy].isStopped
            strategies[strategy].lossTradeRun = tradingMetaData.strategies[strategy].lossTradeRun
        }
        // Note, I think if you turn trade off in the NBT Hub you don't get the strategy in the payload, so you'll lose the name anyway
        strategies[strategy].name = tradingMetaData.strategies[strategy].name
    }
}

// Checks to see if all your open trades are also still open on the NBT Hub
// To stop this from spamming while you are setting up your strategies, we'll only run it if it has been more than two minutes
let checkedStrategies = 0
async function compareStrategyTrades() {
    const elapsed = Date.now() - checkedStrategies
    if (elapsed >= 2 * 60 * 1000 || elapsed < 0) {
        logger.info("Comparing open trades to source strategies...")
        // Only check the strategies that are still running normally
        for (let strategy of Object.values(tradingMetaData.strategies).filter(strategy => strategy.isActive && !strategy.isStopped)) {
            // Find all trades for this strategy that are open but not stopped or hodling because they would likely be out of sync
            const userTrades = getStratOpenTrades(strategy)
            // Only compare if at least on trade is open
            if (userTrades.length) {
                // Retrieve the strategy's open trades from the NBT Hub
                const stratTrades = await getStratTradeOpenList(strategy.id).catch((reason) => {
                    logger.silly("compareStrategyTrades->getStratTradeOpenList: " + reason)
                    // As nothing is waiting for this, we'll just exit if there is a failure
                    return Promise.resolve(undefined)
                })
                if (stratTrades == undefined) return Promise.resolve()

                // Check that each open user trade is still open in the strategy
                for (const tradeOpen of userTrades) {
                    if (!getTradeOpenFiltered(tradeOpen, stratTrades).length) {
                        const logMessage = `${getLogName(tradeOpen)} trade is no longer open in the source strategy, you may have missed the close signal.`
                        logger.warn(logMessage)
                        // Send notification that the trade is no longer valid
                        notifyAll(getNotifierMessage(MessageType.WARN, undefined, undefined, tradeOpen, logMessage as string)).catch((reason) => {
                            logger.silly("checkOpenTrades->notifyAll: " + reason)
                        })
                    }
                }
            }
        }
        checkedStrategies = Date.now()
    }
}

// Process automatic buy signal from NBT Hub
// For a LONG trade it will buy first (then sell later on closing)
// For a SHORT trade this will buy and repay the loan to close the trade
export async function onBuySignal(signalJson: SignalJson, timestamp: Date) {
    if (!isOperational) {
        const logMessage = `Skipping signal as trader is not yet operational.`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }

    const signal = new Signal(signalJson, timestamp)

    // Determine whether this is a long or short trade
    switch (signal.entryType) {
        case EntryType.ENTER: {
            // Buy to enter signals a long trade.
            signal.positionType = PositionType.LONG
            break
        }
        case EntryType.EXIT: {
            // Buy to exit signals a short trade.
            signal.positionType = PositionType.SHORT
            break
        }
        default:
            // Undexpected entry type, this shouldn't happen
            logger.error(logDefaultEntryType)
            return
    }

    logSignal(signal, "buy")

    // Add the trade signal to the queue because we want each signal to process before the next comes
    queue.add(() => trade(signal, SourceType.SIGNAL)).catch((reason) => {
        logger.silly("onBuySignal->trade: " + reason)
        // If it fails it should already have been logged and cleaned up, the socket doesn't care
    })
}

// Process automatic sell signal from NBT Hub
// For a SHORT trade this will borrow and then sell first (then buy and replay later on closing)
// For a LONG trade this will sell to close the trade
export async function onSellSignal(signalJson: SignalJson, timestamp: Date) {
    if (!isOperational) {
        const logMessage = `Skipping signal as trader is not yet operational.`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }

    const signal = new Signal(signalJson, timestamp)
    
    // Determine whether this is a long or short trade
    switch (signal.entryType) {
        case EntryType.ENTER: {
            // Sell to enter signals a short trade.
            signal.positionType = PositionType.SHORT
            break
        }
        case EntryType.EXIT: {
            // Sell to enter signals a long trade.
            signal.positionType = PositionType.LONG
            break
        }
        default:
            // Undexpected entry type, this shouldn't happen
            logger.error(logDefaultEntryType)
            return
    }

    logSignal(signal, "sell")

    // Add the trade signal to the queue because we want each signal to process before the next comes
    queue.add(() => trade(signal, SourceType.SIGNAL)).catch((reason) => {
        logger.silly("onSellSignal->trade: " + reason)
        // If it fails it should already have been logged and cleaned up, the socket doesn't care
    })
}

// Process close trade signal from NBT Hub - this sells for LONG trades or buys for SHORT trades
// This is triggered when the user manually tells the trade to close
export async function onCloseTradedSignal(signalJson: SignalJson, timestamp: Date) {
    if (!isOperational) {
        const logMessage = `Skipping signal as trader is not yet operational.`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }

    const signal = new Signal(signalJson, timestamp)
    signal.entryType = EntryType.EXIT
    logSignal(signal, "close")
    
    // Add the trade signal to the queue because we want each signal to process before the next comes
    queue.add(() => trade(signal, SourceType.MANUAL)).catch((reason) => {
        // This was rejected before the trade even started
        if (!checkFailedCloseTrade(signal)) {
            // User tried to close an open trade and it could not be processed
            logger.silly("onCloseTradedSignal->trade: " + reason)
            // If it fails it should already have been logged and cleaned up, the socket doesn't care
        }
    })
}

// Used by the web server to allow users to close trades manually
export function closeTrade(tradeId: string) {
    const tradeOpen = tradingMetaData.tradesOpen.find(trade => trade.id == tradeId)
    if (tradeOpen) {
        // Check that the trade isn't already closing, maybe the user clicked twice
        if (!tradingMetaData.tradesClosing.has(tradeOpen)) {
            // We don't know what the closing price is, so we'll just have to use the original opening price
            if (tradeOpen.positionType == PositionType.SHORT) {
                if (!tradeOpen.priceBuy) tradeOpen.priceBuy = tradeOpen.priceSell
            } else {
                if (!tradeOpen.priceSell) tradeOpen.priceSell = tradeOpen.priceBuy
            }

            logger.info(`Closing ${getLogName(tradeOpen)} trade.`)
            scheduleTrade(tradeOpen, EntryType.EXIT, SourceType.MANUAL)
            return getLogName(tradeOpen)
        } else {
            logger.warn(`${getLogName(tradeOpen)} trade is already closing.`)
        }
    }

    return ""
}

// There are two special case either where the user has stopped a trade then tried to close it and it failed, or it was previously a bad trade that couldn't be reloaded
// In these cases we just want to get rid of the trade so that it does not hang around on the NBT Hub
function checkFailedCloseTrade(signal: Signal) {
    // Check if the trade couldn't be closed because there were multiple matches (i.e. both a short and long trade)
    if (!signal.positionType && getTradeOpenFiltered(signal, tradingMetaData.tradesOpen).length > 1) {
        return false
    }

    // See if it was for a trade we already know about
    let tradeOpen = getTradeOpen(signal)
    let fake = false

    if (!tradeOpen) {
        // This must have been a bad trade that couldn't be loaded on startup, so we'll signal that it was closed to clear it from the NBT Hub
        // Build a fake trade with the information we do have so that this can be sent back to the NBT Hub
        const strategy = tradingMetaData.strategies[signal.strategyId]
        tradeOpen = {
            id: "F" + Date.now(), // Doesn't matter
            isStopped: true, // Say it was stopped so it moves to the next step below
            isHodl: false,
            positionType: PositionType.LONG, // We need to know the position type to trigger the right signal back, but we don't know it anymore
            tradingType: strategy ? strategy.tradingType : TradingType.virtual, // Get it from the strategy if available, otherwise just guess
            quantity: strategy ? strategy.tradeAmount : new BigNumber(1), // Quantity is used in the response, but I don't think it makes a difference what it is
            strategyId: signal.strategyId,
            strategyName: signal.strategyName,
            symbol: signal.symbol,
            timeUpdated: new Date(),
            isExecuted: false
        }
        fake = true
    }

    // Either stopped previously, or the fake trade will always be stopped
    if (tradeOpen.isStopped) {
        if (fake) {
            logger.error(`Unknown trade for ${getLogName(signal)} signal, so just going to fake two responses back to the NBT Hub to drop the trade.`)

            // Tell NBT Hub that the trade was closed even though it probably wasn't
            // As we don't know whether the original trade was SHORT or LONG, we're going to trigger both responses
            emitSignalTraded(`traded_buy_signal`, tradeOpen)
            emitSignalTraded(`traded_sell_signal`, tradeOpen)
        } else {
            logger.error(`Could not close stopped trade ${getLogName(tradeOpen)} properly, so just going to fake a response back to the NBT Hub to drop the trade.`)

            // Tell NBT Hub that the trade was closed even though it probably wasn't
            emitSignalTraded(`traded_${tradeOpen.positionType == PositionType.SHORT ? ActionType.BUY : ActionType.SELL}_signal`, tradeOpen)

            // Remove the closed trade
            removeTradeOpen(tradeOpen)

            // Note, this doesn't update balances or PnL, so these might be incorrect now too

            if (tradeOpen.tradingType == TradingType.virtual) {
                logger.warn(`A virtual trade was deleted, you will probably need to reset virtual balances.`)
            }
        }

        // This is ok to ignore
        return true
    }

    // Don't ignore this error
    return false
}

// Process stop trade signal from NBT Hub - this just terminates the trade without buying or selling
// This is triggered when the user manually tells the trade to stop
export async function onStopTradedSignal(signalJson: SignalJson, timestamp: Date) {
    if (!isOperational) {
        const logMessage = `Skipping signal as trader is not yet operational.`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }

    const signal = new Signal(signalJson, timestamp)
    logSignal(signal, "stop")

    const tradeOpen = getTradeOpen(signal)
    if (!tradeOpen) {
        logger.error(logTradeOpenNone)
        return Promise.reject(logTradeOpenNone)
    }

    tradeOpen.isStopped = true
    saveState("tradesOpen")
}

function logSignal(signal: Signal, type: "buy" | "sell" | "close" | "stop") {
    let message = `Received a`
    switch (type) {
        case "close":
        case "stop":
            message += ` ${type} trade signal`
            break
        default:
            message += signal.entryType == EntryType.ENTER ? "n opening" : " closing"
            message += ` ${type} (${signal.entryType} ${signal.positionType}) signal`

            // Keep a record of all strategies broadcasting public signals
            const pStrat = new PublicStrategy(signal)
            if (tradingMetaData.publicStrategies[pStrat.id]) {
                // Copy previous stats
                pStrat.shortOpened += tradingMetaData.publicStrategies[pStrat.id].shortOpened
                pStrat.longOpened += tradingMetaData.publicStrategies[pStrat.id].longOpened
                pStrat.closed += tradingMetaData.publicStrategies[pStrat.id].closed
            }
            tradingMetaData.publicStrategies[pStrat.id] = pStrat
    }
    message += ` for ${getLogName(signal)}.`
    const strategy = tradingMetaData.strategies[signal.strategyId]
    if (strategy) {
        // Because we don't get the strategy name with the strategy we have to copy it from the signal (for logging)
        if (!strategy.name && signal.strategyName) {
            strategy.name = signal.strategyName
            saveState("strategies")
        }
        logger.info(message)
    } else if (type == "close" || type == "stop") {
        // Still want to see close and stop even if no longer following the strategy
        logger.info(message)
    } else {
        // Not following the strategy so these will be ignored
        logger.debug(message)
    }
}

// Validates that the symbol can still be traded on Binance
function checkSymbol(symbol: string, prefixMsg: string, wallet?: WalletType): Market {
    // Get the information on symbols and limits for this coin pair from the Binance exchange
    const market = tradingMetaData.markets[symbol]

    if (!market) {
        const logMessage = `${prefixMsg} as there is no market data for symbol ${symbol}.`
        logger.error(logMessage)
        throw logMessage
    }

    if (env().EXCLUDE_COINS) {
        // Check if either coin has been added to the exclude list (hopefully you would only exclude the base)
        const excluded = env().EXCLUDE_COINS.split(",").map(function(item: string) { return item.trim().toUpperCase() })
        if (excluded.includes(market.base) || excluded.includes(market.quote)) {
            const logMessage = `${prefixMsg} as trading is excluded for ${market.symbol}.`
            logger.warn(logMessage)
            throw logMessage
        }
    }

    if (!market.active) {
        const logMessage = `${prefixMsg} as the market for symbol ${market.symbol} is inactive.`
        logger.error(logMessage)
        throw logMessage
    }

    if (wallet) {
        // Check that trading is allowed on the selected wallet
        if (!(wallet == WalletType.SPOT ? market.spot : market.margin)) {
            const logMessage = `${prefixMsg} as ${wallet} trading is not available for symbol ${market.symbol}.`
            logger.error(logMessage)
            throw logMessage
        }
    } else if (!market.spot && !market.margin) {
        // Hopefully this won't happen
        const logMessage = `${prefixMsg} as neither margin trading nor spot trading is available for symbol ${market.symbol}.`
        logger.error(logMessage)
        throw logMessage
    }

    // All good, so return the valid market data
    return market
}

// Validates that the trading signal is consistent with the selected strategies and configuration
function checkTradingData(signal: Signal, source: SourceType): TradingData {
    const strategy = tradingMetaData.strategies[signal.strategyId]

    // Only check the strategy for auto trades, this allows you to manually close any trade
    if (source == SourceType.SIGNAL) {
        if (!strategy) {
            const logMessage = `Skipping signal as strategy for ${getLogName(signal)} isn't followed.`
            logger.debug(logMessage)
            throw logMessage
        }

        if (!strategy.isActive) {
            const logMessage = `Skipping signal as strategy for ${getLogName(signal)} isn't active.`
            logger.warn(logMessage)
            throw logMessage
        }
    }

    // Try to find a previous open trade
    const tradeOpen = getTradeOpen(signal)

    // Validate that trading on this symbol is allowed, and get the information on symbols and limits for this coin pair from Binance exchange
    const market = checkSymbol(signal.symbol, "Skipping signal", tradeOpen?.wallet)

    switch (signal.entryType) {
        case EntryType.ENTER:
            // Check if strategy has hit the losing trade limit
            if (!strategy || strategy.isStopped) {
                const logMessage = `Skipping signal as strategy for ${getLogName(signal)} has been stopped.`
                logger.warn(logMessage)
                throw logMessage
            }

            // If this is supposed to be a new trade, check there wasn't an existing one
            // This is a workaround for an issue in the NBT Hub, if you miss a close signal while your trader is offline then you may get another open signal for something that is already open
            // It seems the NBT Hub will ignore the second traded_buy/sell_signal and only track the first open trade, so if we open a second one in the trader it will be orphaned and never close
            // So until we have a unique ID that is provided on the signal and NBT Hub can track them correctly, we're just going to have to ignore concurrent trades and treat this as a continuation
            if (tradeOpen) {
                const logMessage = `Skipping signal as an existing open trade was already found for ${getLogName(signal)}.`
                logger.warn(logMessage)
                throw logMessage
            }

            // Check if the trade limit threshold has been hit, a threshold of zero will essentially enforce a trade limit per strategy
            // Assuming all open trades will lose, this will limit the number of open trades so that losses won't exceed the loss limit
            // Obviously if more trades opened before the threshold was hit then it cannot control that
            if (env().STRATEGY_LOSS_LIMIT && strategy.lossTradeRun >= env().STRATEGY_LOSS_LIMIT * env().STRATEGY_LIMIT_THRESHOLD && getStratOpenTrades(strategy).length >= (env().STRATEGY_LOSS_LIMIT - strategy.lossTradeRun)) {
                const logMessage = `Skipping signal as strategy for ${getLogName(signal)} has reached the threshold for limiting open trades.`
                logger.warn(logMessage)
                throw logMessage
            }
            break
        case EntryType.EXIT:
            // If this is supposed to be a trade exit, check the trade was actually open
            if (!tradeOpen) {
                logger.warn(logTradeOpenNone)
                throw logTradeOpenNone
            }

            // Check that the trade is not already closing
            if (tradingMetaData.tradesClosing.has(tradeOpen)) {
                const logMessage = `Skipping duplicate signal as trade ${getLogName(tradeOpen)} is already closing.`
                logger.warn(logMessage)
                throw logMessage
            }

            // Can't automatically close a stopped trade, but will still let through a manual close
            if (source == SourceType.SIGNAL && tradeOpen.isStopped) {
                const logMessage = `Skipping signal as trade ${getLogName(tradeOpen)} is stopped.`
                logger.warn(logMessage)
                throw logMessage
            }

            if (!signal.positionType) {
                // Needed for manual close signals
                logger.debug(`Getting position type from open trade: ${tradeOpen.positionType}.`)
                signal.positionType = tradeOpen.positionType
            }

            if (!signal.price) {
                // Hopefully this won't happen anymore
                logger.warn(`Signal didn't have a price, using original buy or sell price from the open trade.`)
                signal.price = tradeOpen.priceBuy
                if (!signal.price) signal.price = tradeOpen.priceSell
            }

            // Check to satisfy the compiler, if no price it will fail later anyway
            if (signal.price) {
                // Calculate whether this trade will make a profit or loss
                const percent = signal.positionType == PositionType.LONG ? calculatePnL(tradeOpen.priceBuy!, signal.price) : calculatePnL(signal.price, tradeOpen.priceSell!)
                logger.debug(`Closing ${percent.isLessThan(0) ? "loss" : "profit"} for ${getLogName(tradeOpen)} trade will be ${percent.toFixed(3)}% with fees.`)

                // Check if strategy has hit the losing trade limit, and this an automatic trade signal
                // Of if the user has decided to HODL the trade
                // Strategy may be undefined if no longer followed, but then we should only get here for a manual close
                if ((!strategy || strategy.isStopped || tradeOpen.isHodl) && source == SourceType.SIGNAL && signal.price) {
                    let reason = ""
                    if (tradeOpen.isHodl) {
                        reason = `${getLogName(tradeOpen)} trade is set to HODL`
                    } else {
                        reason = `strategy for ${getLogName(signal)} has been stopped`
                    }
                    if (percent.isLessThan(0)) {
                        const logMessage = `Skipping signal as ${reason} and this trade will make another loss, close it manually or wait for a better close signal.`
                        logger.error(logMessage)
                        throw logMessage
                    } else {
                        // Winning trades are allowed through
                        logger.warn(`The ${reason}, but this should be a winning trade so it will execute.`)
                    }
                }
            }
            break
        default:
            logger.error(logDefaultEntryType)
            throw logDefaultEntryType
    }

    // Always need a price
    if (!signal.price) {
        const logMessage = `Skipping signal for ${getLogName(signal)} as price was missing.`
        logger.error(logMessage)
        throw logMessage
    }

    // Check if this type of trade can be executed
    switch (signal.positionType) {
        case PositionType.LONG:
            if (signal.entryType === EntryType.ENTER && env().MAX_LONG_TRADES && getOpenTradeCount(signal.positionType, strategy.tradingType) >= env().MAX_LONG_TRADES) {
                const logMessage = "Skipping signal as maximum number of short trades has been reached."
                logger.warn(logMessage)
                throw logMessage
            }
            break
        case PositionType.SHORT:
            // We can still close SHORT trades if they were previously opened on margin, so only skip the open trade signals
            if (signal.entryType === EntryType.ENTER) {
                if (!env().IS_TRADE_SHORT_ENABLED) {
                    const logMessage = "Skipping signal as short trading is disabled."
                    logger.warn(logMessage)
                    throw logMessage
                }

                if (!env().IS_TRADE_MARGIN_ENABLED) {
                    const logMessage = "Skipping signal as margin trading is disabled but is required for short trading."
                    logger.warn(logMessage)
                    throw logMessage
                }

                if (env().MAX_SHORT_TRADES && getOpenTradeCount(signal.positionType, strategy.tradingType) >= env().MAX_SHORT_TRADES) {
                    const logMessage = "Skipping signal as maximum number of short trades has been reached."
                    logger.warn(logMessage)
                    throw logMessage
                }
            }

            if (!market.margin) {
                const logMessage = `Failed to trade as margin trading is unavailable for a short position on symbol ${market.symbol}.`
                logger.error(logMessage)
                throw logMessage
            }
            break
        default:
            // Hopefully this shouldn't happen
            logger.error(logDefaultPositionType)
            throw logDefaultPositionType
    }

    // TODO: Because BNB has a special purpose for fees, extra logic would be needed to cater for this throughout the trader if used as the quote coin
    // At time of writing there are no strategies that use BNB as the quote coin
    if (market.quote == "BNB") {
        logger.warn(`The trader has not been tested for strategies that use BNB as the quote coin. Some features like estimated fees and PnL will be incorrect. Please contact Spat on Discord.`)
        // The trade should still execute ok
    }

    return {
        market,
        signal,
        strategy,
    }
}

// Checks that the current trades are still able to be closed on Binance
function checkOpenTrades() {
    if (isOperational) {
        for (let trade of tradingMetaData.tradesOpen) {
            // The user can manually stop the trade if this message gets annoying each day
            if (!trade.isStopped) {
                try {
                    // Validate that trading on this symbol is allowed
                    checkSymbol(trade.symbol, `${getLogName(trade)} trade is no longer valid`, trade.wallet)
                } catch (reason) {
                    // Send notification that the trade is no longer valid
                    notifyAll(getNotifierMessage(MessageType.WARN, undefined, undefined, trade, reason as string)).catch((reason) => {
                        logger.silly("checkOpenTrades->notifyAll: " + reason)
                    })
                }
            }
        }
    }
}

// Adds the before, main action, and after functions to execute buy/sell and borrow/repay commands on Binance
export function getTradingSequence(
    tradeOpen: TradeOpen,
    entryType: EntryType,
    source: SourceType,
    signal?: Signal
): TradingSequence {
    const market = tradingMetaData.markets[tradeOpen.symbol]
    let tradingSequence: TradingSequence | undefined

    let action: ActionType | undefined
    let borrowAsset = ""

    // Just in case
    if (!tradeOpen.borrow) tradeOpen.borrow = new BigNumber(0)
    
    // Determine the action and asset to borrow based on the position and entry type
    switch (tradeOpen.positionType) {
        case PositionType.LONG:
            borrowAsset = market.quote
            switch (entryType) {
                case EntryType.ENTER:
                    action = ActionType.BUY
                    break
                case EntryType.EXIT:
                    action = ActionType.SELL
                    break
            }
            break
        case PositionType.SHORT:
            borrowAsset = market.base
            switch (entryType) {
                case EntryType.ENTER:
                    action = ActionType.SELL
                    break
                case EntryType.EXIT:
                    action = ActionType.BUY
                    break
            }
            break
    }

    // Execute the main buy/sell action for the trade
    const order = () => executeTradeAction(tradeOpen, source, action!, market.symbol, tradeOpen.quantity, signal)

    // Check if we need to borrow funds to open this trade
    const borrow = 
        tradeOpen.borrow.isGreaterThan(0) &&
        entryType == EntryType.ENTER
            ? () => executeTradeAction(tradeOpen, source, ActionType.BORROW, borrowAsset, tradeOpen.borrow!, signal)
            : undefined

    // Check if we need to repay funds after closing this trade
    const repay =
        tradeOpen.borrow.isGreaterThan(0) &&
        entryType == EntryType.EXIT
        ? () => executeTradeAction(tradeOpen, source, ActionType.REPAY, borrowAsset, tradeOpen.borrow!, signal)
        : undefined

    // Assemble the trading sequence
    tradingSequence = {
        before: borrow,
        mainAction: order,
        after: repay,
        // Cannot send sell signals to the NBT Hub for auto balancing because it will be treated as a close
        socketChannel: source != SourceType.REBALANCE ? `traded_${action}_signal` : ''
    }

    return tradingSequence
}

// Performs the actual buy, sell, borrow, or repay trade functions, and keeps a record of the transaction
async function executeTradeAction(
    tradeOpen: TradeOpen,
    source: SourceType,
    action: ActionType,
    symbolAsset: string,
    quantity: BigNumber,
    signal?: Signal
) {
    let result: Order | LoanTransaction | null = null

    logger.debug(`Execute ${action} ${quantity.toFixed()} ${symbolAsset} on ${tradeOpen.wallet}.`)

    // Execute the real or virtual actions
    switch (action) {
        case ActionType.BUY:
        case ActionType.SELL:
            result = await (tradeOpen.tradingType == TradingType.real ?
                createMarketOrder(
                    symbolAsset,
                    action,
                    quantity,
                    tradeOpen.wallet!
                )
            :
                createVirtualOrder(
                    tradeOpen,
                    action,
                )
            ).catch((reason) => {
                logger.silly("execute => BUY/SELL: " + reason)
                return Promise.reject(reason)
            })
            break
        case ActionType.BORROW:
            result = await (tradeOpen.tradingType == TradingType.real ?
                marginBorrow(
                    symbolAsset,
                    quantity
                )
            :
                virtualBorrow(
                    symbolAsset,
                    quantity
                )
            ).catch((reason) => {
                logger.silly("execute => BORROW: " + reason)
                return Promise.reject(reason)
            })
            break
        case ActionType.REPAY:
            if (tradeOpen.tradingType == TradingType.real && env().IS_PAY_INTEREST_ENABLED) {
                // Pay any interest accumulated in BNB
                // This needs to be done before repaying the loan in case the loan is also for BNB
                await repayInterest().catch(reason => {
                    logger.silly("executeTradeAction->repayInterest: " + reason)
                    // Not going to stop here because we still want to repay the loan if we can
                })
            }

            result = await (tradeOpen.tradingType == TradingType.real ?
                marginRepay(
                    symbolAsset,
                    quantity
                )
            :
                virtualRepay(
                    symbolAsset,
                    quantity
                )
            ).catch((reason) => {
                logger.silly("execute => REPAY: " + reason)
                return Promise.reject(reason)
            })
            break
    }

    // We want to know as close as possible to when the trade was executed on Binance so that we can compare to the incoming timestamp
    const timestamp = new Date()

    // null is returned for virtual actions, so simulate a successful result object
    if (result == null && (action == ActionType.BUY || action == ActionType.SELL)) {
        // Get the current ticker price
        let price = await fetchTicker(tradingMetaData.markets[tradeOpen.symbol]).then(result => {
            return action == ActionType.BUY ? result.ask : result.bid
        }).catch((reason) => {
            logger.silly("executeTradeAction->fetchTicker: " + reason)
            // Not going to stop, just use the previous price next
            return 0
        })
        // Unlikely, but price might be 0 if there are no orders or it failed to get the price
        if (!price) price = (action == ActionType.BUY ? tradeOpen.priceBuy! : tradeOpen.priceSell!).toNumber()

        result = {
            status: "closed",
            price: price,
            cost: tradeOpen.quantity.multipliedBy(price).toNumber(),

            // Not used
            id: "",
            clientOrderId: "",
            datetime: "",
            timestamp: 0,
            lastTradeTimestamp: 0,
            symbol: "",
            type: "",
            side: 'buy',
            amount: 0,
            filled: 0,
            remaining: 0,
            trades: [],
            fee: {
                type: 'taker',
                currency: "",
                rate: 0,
                cost: 0
            },
            info: null
        }
    }

    // Result will still be null for virtual borrow / repay actions
    if (result) {
        // Status is returned for real buy / sell orders
        if ("status" in result) {
            if (result.status == "closed") {
                // Check if the price and cost is different than we expected (it usually is)
                if (result.price) {
                    switch (action) {
                        case ActionType.BUY:
                            if (!tradeOpen.priceBuy!.isEqualTo(result.price)) {
                                logger.debug(`${getLogName(tradeOpen)} trade buy price slipped from ${tradeOpen.priceBuy!.toFixed()} to ${result.price}.`)
                                // Update the price for better accuracy
                                tradeOpen.priceBuy = new BigNumber(result.price)
                                tradeOpen.timeUpdated = timestamp
                            }
                            break
                        case ActionType.SELL:
                            if (!tradeOpen.priceSell!.isEqualTo(result.price)) {
                                logger.debug(`${getLogName(tradeOpen)} trade sell price slipped from ${tradeOpen.priceSell!.toFixed()} to ${result.price}.`)
                                // Update the price for better accuracy
                                tradeOpen.priceSell = new BigNumber(result.price)
                                tradeOpen.timeUpdated = timestamp

                                // Copy the sell price and cost back to the original trade for auto balancing
                                if (source == SourceType.REBALANCE) {
                                    // Looping because it is easier, but there should only ever be one match
                                    for (const sourceTrade of tradingMetaData.tradesOpen.filter(trade => trade.id == tradeOpen.id)) {
                                        const sourceCost = sourceTrade.quantity.multipliedBy(result.price)
                                        logger.debug(`${getLogName(sourceTrade)} original trade cost has been updated from ${sourceTrade.cost!.toFixed()} to ${sourceCost.toFixed()}.`)
                                        sourceTrade.priceSell = tradeOpen.priceSell
                                        sourceTrade.cost = sourceCost
                                        sourceTrade.timeUpdated = timestamp
                                    }
                                }
                            }
                            break
                    }
                }
                if (result.cost && !tradeOpen.cost!.isEqualTo(result.cost)) {
                    logger.debug(`${getLogName(tradeOpen)} trade cost slipped from ${tradeOpen.cost!.toFixed()} to ${result.cost}.`)
                    // Update the cost for better accuracy
                    tradeOpen.cost = new BigNumber(result.cost)
                    tradeOpen.timeUpdated = timestamp
                }
                // Technically we may not always need to save the trade, but most of the time we will so do it here for simplicity
                saveState("tradesOpen")
            } else {
                // Order did not close successfully
                // Trade information will be added to the log message by the calling method
                return Promise.reject(`Result status was "${result.status}".`)
            }
        } else if (!result.tranId) {
            // Margin borrow and repay will only have a transaction ID, so anything other than that is unexpected
            // Trade information will be added to the log message by the calling method
            return Promise.reject(`Unexpected result: "${result}".`)
        }
    }

    // Update the buy / sell times if successful
    switch (action) {
        case ActionType.BUY:
            tradeOpen.timeBuy = timestamp
            saveState("tradesOpen")
            break
        case ActionType.SELL:
            tradeOpen.timeSell = timestamp
            saveState("tradesOpen")
            break
    }

    // Record transaction
    const transaction = new Transaction(timestamp, tradeOpen, source, action, symbolAsset, quantity, signal)
    tradingMetaData.transactions.push(transaction)
    saveRecord("transaction", transaction)
    // Truncate memory array
    while (tradingMetaData.transactions.length > 1 && tradingMetaData.transactions.length > env().MAX_LOG_LENGTH) {
        tradingMetaData.transactions.shift()
    }

    return Promise.resolve(result)
}

// Repays all the interest accumulated in BNB
// This assumes that the user has selected the "Using BNB For Interest option" in Binance so that all interest is accumulated in the one place
async function repayInterest() {
    // Get the margin balance info
    const balance = await fetchBalance(WalletType.MARGIN).catch((reason) => {
        logger.silly("repayInterest->fetchBalance: " + reason)
        return Promise.reject(reason)
    })
    
    // Extract BNB loan information from balances
    const marginLoan = getMarginLoans(balance)["BNB"]

    // Start with the full interest amount then check if there is enough free balance to pay it
    let repay = marginLoan.interest
    if (repay > balance["BNB"].free) {
        logger.warn(`Not enough free BNB to repay the outstanding interest of ${repay}, you will need to top up the balance and repay it manually.`)
        // So just repay the maximum that we can
        repay = balance["BNB"].free
    }
    if (repay) {
        logger.info(`Repaying interest of ${repay} BNB.`)
        const result = await marginRepay("BNB", new BigNumber(repay)).catch((reason) => {
            const logMessage = `An error occurred when repaying interest: ${reason}`
            logger.error(logMessage)
            return Promise.reject(logMessage)
        })
        if (!result.tranId) {
            const logMessage = `Unexpected result when repaying interest: "${result}".`
            logger.error(logMessage)
            return Promise.reject(logMessage)
        }
    }
}

// Simulates buy and sell transactions on the virtual balances
// Has to be async to emulate a Binance order
async function createVirtualOrder(
    tradeOpen: TradeOpen,
    action: ActionType
): Promise<null> {
    const market = tradingMetaData.markets[tradeOpen.symbol]
    
    // Update virtual balances with buy and sell quantities
    switch (action) {
        case ActionType.BUY:
            tradingMetaData.virtualBalances[tradeOpen.wallet!][market.base] = tradingMetaData.virtualBalances[tradeOpen.wallet!][market.base].plus(tradeOpen.quantity)
            tradingMetaData.virtualBalances[tradeOpen.wallet!][market.quote] = tradingMetaData.virtualBalances[tradeOpen.wallet!][market.quote].minus(tradeOpen.quantity.multipliedBy(tradeOpen.priceBuy!))
            break
        case ActionType.SELL:
            tradingMetaData.virtualBalances[tradeOpen.wallet!][market.base] = tradingMetaData.virtualBalances[tradeOpen.wallet!][market.base].minus(tradeOpen.quantity)
            tradingMetaData.virtualBalances[tradeOpen.wallet!][market.quote] = tradingMetaData.virtualBalances[tradeOpen.wallet!][market.quote].plus(tradeOpen.quantity.multipliedBy(tradeOpen.priceSell!))
            break
    }
    saveState("virtualBalances")

    logger.debug(`After ${action}, current ${tradeOpen.wallet} virtual balances are now ${tradingMetaData.virtualBalances[tradeOpen.wallet!][market.base]} ${market.base} and ${tradingMetaData.virtualBalances[tradeOpen.wallet!][market.quote]} ${market.quote}.`)
    return Promise.resolve(null)
}

// Simulates borrowing on the virtual balances
// Has to be async to emulate a Binance request
async function virtualBorrow(asset: string, quantity: BigNumber): Promise<null> {
    if (quantity.isGreaterThan(0)) {
        tradingMetaData.virtualBalances[WalletType.MARGIN][asset] = tradingMetaData.virtualBalances[WalletType.MARGIN][asset].plus(quantity)
        saveState("virtualBalances")

        logger.debug(`After borrow, current ${WalletType.MARGIN} virtual balance is now ${tradingMetaData.virtualBalances[WalletType.MARGIN!][asset]} ${asset}.`)
    }
    return Promise.resolve(null)
}

// Simulates repaying borrowed funds on the virtual balances
// Has to be async to emulate a Binance request
async function virtualRepay(asset: string, quantity: BigNumber): Promise<null> {
    if (quantity.isGreaterThan(0)) {
        tradingMetaData.virtualBalances[WalletType.MARGIN][asset] = tradingMetaData.virtualBalances[WalletType.MARGIN][asset].minus(quantity)
        saveState("virtualBalances")

        logger.debug(`After repay, current ${WalletType.MARGIN} virtual balance is now ${tradingMetaData.virtualBalances[WalletType.MARGIN!][asset]} ${asset}.`)
    }
    return Promise.resolve(null)
}

// Excute the before, main action, and after commands in the trading sequence, this is triggered by processing the trading queue
// Once successful, it will remove any complete trades from the meta data
// If a trade failed to execute then it will not be removed, maybe another exit signal will try to close it again or the user can try manually once they have resolved the cause of the problem
// It is possible that a SHORT trade failed on the repay action, this could cause some discrepancies in the balances, so these will be stopped and user will probably have to clean it up
// Some trades may be the result of rebalancing, so no signal is available
export async function executeTradingTask(
    tradeOpen: TradeOpen,
    tradingSequence: TradingSequence,
    source: SourceType,
    signal?: Signal
) {
    logger.debug(`${signal ? signal.entryType == EntryType.ENTER ? "Enter" : "Exit" : "Execut"}ing a ${tradeOpen.tradingType} ${tradeOpen.positionType} trade on ${tradeOpen.wallet} for ${tradeOpen.quantity.toFixed()} units of symbol ${tradeOpen.symbol}.`)

    // Track whether parts of the trade failed
    let anythingDone = false

    // This might be a borrow request for margin trading
    if (tradingSequence.before) {
        await tradingSequence
            .before()
            .then(() => {
                anythingDone = true
                logger.debug(`Successfully executed the ${getLogName(tradeOpen)} trading sequence's before step.`)
            })
            .catch((reason) => {
                // Don't need to stop the trade as nothing has been done, maybe it will retry on the next exit signal, so just log and exit

                // Trade won't be closing anymore
                tradingMetaData.tradesClosing.delete(tradeOpen)

                const logMessage = `Failed to execute the ${getLogName(tradeOpen)} trading sequence's before step: ${reason}`
                logger.error(logMessage)
                return Promise.reject(logMessage)
            })
    }

    // Ths would be the actual buy / sell request
    await tradingSequence
        .mainAction()
        .then(() => {
            anythingDone = true
            logger.debug(`Successfully executed the ${getLogName(tradeOpen)} trading sequence's main action step.`)
            // Notify NBT Hub that trade has been executed
            emitSignalTraded(tradingSequence.socketChannel, tradeOpen)
        })
        .catch((reason) => {
            // Setting this to stopped because something partially worked, user will have to manually clean it up and close
            if (anythingDone) {
                tradeOpen.isStopped = true
                saveState("tradesOpen")
            }

            // Trade won't be closing anymore
            tradingMetaData.tradesClosing.delete(tradeOpen)

            const logMessage = `Failed to execute the ${getLogName(tradeOpen)} trading sequence's main action step${anythingDone ? ", trade has been stopped": ""}: ${reason}`
            logger.error(logMessage)
            return Promise.reject(logMessage)
        })

    // This might be a repayment request for margin trading
    if (tradingSequence.after) {
        await tradingSequence
            .after()
            .then(() => {
                anythingDone = true
                logger.debug(`Successfully executed the ${getLogName(tradeOpen)} trading sequence's after step.`)
            })
            .catch((reason) => {
                // Setting this to stopped because something partially worked, user will have to manually clean it up and close
                if (anythingDone) {
                    tradeOpen.isStopped = true
                    saveState("tradesOpen")
                }

                // Trade won't be closing anymore
                tradingMetaData.tradesClosing.delete(tradeOpen)

                const logMessage = `Failed to execute the ${getLogName(tradeOpen)} trading sequence's after step${anythingDone ? ", trade has been stopped": ""}: ${reason}`
                logger.error(logMessage)
                return Promise.reject(logMessage)
            })
    }

    // Binance balances don't synchronise immediately, so it is best to wait until we are sure the trade executed before we stop tracking it
    tradingMetaData.tradesClosing.delete(tradeOpen)

    // Update trade status after successful processing
    tradeOpen.isExecuted = true
    saveState("tradesOpen")

    const market = tradingMetaData.markets[tradeOpen.symbol]

    const action = signal ? signal.entryType == EntryType.ENTER && signal.positionType == PositionType.LONG || signal.entryType == EntryType.EXIT && signal.positionType == PositionType.SHORT ? ActionType.BUY : ActionType.SELL : ActionType.SELL
    const timestamp = action == ActionType.BUY ? tradeOpen.timeBuy?.getTime() : tradeOpen.timeSell?.getTime()
    const diff = signal && timestamp ? timestamp - signal.timestamp.getTime() : undefined
    const info = source == SourceType.SIGNAL ? `within ${diff} milliseconds of the signal` : `for ${source}`
    logger.info(`${getLogName(tradeOpen)} trade successfully ${action == ActionType.BUY ? "bought" : "sold" } ${tradeOpen.quantity} ${market.base} for ${tradeOpen.cost} ${market.quote} on ${tradeOpen.wallet} ${info}.`)

    if ((signal && signal.entryType == EntryType.EXIT) || source == SourceType.MANUAL) {
        // Remove the completed trade if exit or manual close (rebalance won't be in the trade list)
        removeTradeOpen(tradeOpen)
    }

    logger.debug(`Now ${tradingMetaData.tradesOpen.length} open trades and ${tradingMetaData.tradesClosing.size} closing trades.`)

    // Prices should have just been updated by the order result
    // Calculate the change in value, for checking loss limit and updating balance history
    // An exit signal covers automatic or manual close, rebalancing won't have a signal, but each of these can result in a profit or loss
    let change = undefined
    if (tradeOpen.priceBuy && tradeOpen.priceSell && (!signal || signal.entryType == EntryType.EXIT)) {
        // Regardless of whether this was SHORT or LONG, you should always buy low and sell high
        // Need change without fees for the balance history later
        change = tradeOpen.quantity.multipliedBy(tradeOpen.priceSell).minus(tradeOpen.quantity.multipliedBy(tradeOpen.priceBuy))
        const percent = calculatePnL(tradeOpen.priceBuy, tradeOpen.priceSell)
        logger.debug(`Closing ${change.isLessThan(0) ? "loss" : "profit"} for ${getLogName(tradeOpen)} trade was ${change.toFixed()} ${market.quote} (or ${percent.toFixed(3)}% with fees).`)

        const strategy = tradingMetaData.strategies[tradeOpen.strategyId]
        // Manually closing a trade or rebalancing should not affect the count of losses
        if (strategy && source == SourceType.SIGNAL && signal) {
            // Check for losing trade with fees
            if (percent.isLessThan(0)) {
                // Losing trade, increase the count
                strategy.lossTradeRun++

                // Check for the loss limit
                // Multiple losing trades may be in the queue, so only log the stop once
                if (!strategy.isStopped && env().STRATEGY_LOSS_LIMIT && strategy.lossTradeRun >= env().STRATEGY_LOSS_LIMIT) {
                    const logMessage = `${getLogName(signal)} has had too many losing trades, stopping new trades for this strategy.`
                    logger.error(logMessage)
                    strategy.isStopped = true

                    // Send notifications that strategy is stopped
                    notifyAll(getNotifierMessage(MessageType.WARN, undefined, signal, undefined, logMessage)).catch((reason) => {
                        logger.silly("trade->notifyAll: " + reason)
                    })
                }
                saveState("strategies")
            } else {
                if (strategy.lossTradeRun > 0) logger.debug(`${getLogName(signal)} had ${strategy.lossTradeRun} losses in a row.`)

                // Winning trade, reset the count
                strategy.lossTradeRun = 0
            }
        }
    }

    // Regardless of whether it is buy, sell, or rebalance, every time there is a transaction there is a fee
    const fee = tradeOpen.cost!.multipliedBy(env().TAKER_FEE_PERCENT / 100).negated()

    // Send the entry type and/or value change to the balance history
    updateBalanceHistory(tradeOpen.tradingType!, market.quote, signal?.entryType, undefined, change, fee)

    // Send notifications that trading completed successfully
    notifyAll(getNotifierMessage(MessageType.SUCCESS, source, signal, tradeOpen)).catch((reason) => {
        logger.silly("executeTradingTask->notifyAll: " + reason)
    })

    if (tradeOpen.tradingType == TradingType.real) {
        // Check that you still have enough BNB in this wallet
        checkBNBThreshold(tradeOpen.wallet!).catch((reason) => {
            logger.silly("executeTradingTask->checkBNBThreshold: " + reason)
        })
    }
}

// Notify NBT Hub that the trade has been executed
function emitSignalTraded(channel: string, tradeOpen: TradeOpen) {
    // Some trades may be silent (i.e. auto balancing)
    if (channel != '') socket.emitSignalTraded(channel, tradeOpen.symbol, tradeOpen.strategyId, tradeOpen.strategyName, tradeOpen.quantity, tradeOpen.tradingType!)
}

// Creates the trading sequence and adds it to the trading queue
function scheduleTrade(
    tradeOpen: TradeOpen,
    entryType: EntryType,
    source: SourceType,
    signal?: Signal
) {
    // Track closing trades so that available balances can be calculated before they execute
    if (entryType == EntryType.EXIT) tradingMetaData.tradesClosing.add(tradeOpen)

    // Create the borrow / buy / sell sequence for the trade queue
    const tradingSequence = getTradingSequence(tradeOpen!, entryType, source, signal)

    queue.add(() => executeTradingTask(tradeOpen!, tradingSequence, source, signal))
        .catch((reason) => {
            logger.silly("scheduleTrade->executeTradingTask: " + reason)

            // Add a full stop in case we need another sentance, sometimes the error details may not have it
            if (reason.slice(-1) != ".") reason += "."

            switch (source) {
                case SourceType.MANUAL:
                    // We got to this point because the trade was potentially valid, but it failed to execute on Binance
                    // If the user is just trying to close the trade manually, see if we can just drop the trade anyway
                    // But we will still send a notification of the error later
                    if (signal) checkFailedCloseTrade(signal)
                    break
                case SourceType.REBALANCE:
                    // Need to restore the quantity/cost to the parent trade
                    const parentTrade = getTradeOpen(tradeOpen)
                    if (parentTrade && parentTrade != tradeOpen) {
                        logger.debug(`Restoring quantity and cost from the failed rebalancing trade to the original ${getLogName(parentTrade)} trade.`)
                        parentTrade.quantity = parentTrade.quantity.plus(tradeOpen.quantity)
                        parentTrade.cost = parentTrade.cost!.plus(tradeOpen.cost!)
                        parentTrade.timeUpdated = new Date()
                        saveState("tradesOpen")
                    } else {
                        // Hopefully this won't happen
                        const rebalanceError = "Could not restore rebalancing values to original trade, you may need to sell manually in Binance."
                        logger.error(rebalanceError)
                        // Append the additional message for the notifications
                        reason += " " + rebalanceError
                    }
                    break
                case SourceType.SIGNAL:
                    if (signal && signal.entryType == EntryType.ENTER && !tradeOpen.isExecuted) {
                        const openError = "Trade was never opened, so it will be discarded."
                        logger.error(openError)
                        // Append the additional message for the notifications
                        reason += " " + openError

                        // The trade was never acknowledged back to the NBT Hub, so we shouldn't keep it either
                        // It is possible that a following close or rebalance was started before this errored, that might cause problems, but it should be rare
                        removeTradeOpen(tradeOpen)
                    }
                    break
            }

            // Send notifications that trading failed
            notifyAll(getNotifierMessage(MessageType.ERROR, source, signal, tradeOpen, reason)).catch((reason) => {
                logger.silly("scheduleTrade->notifyAll: " + reason)
            })

            // Note, this won't return in this scheduleTrade method as the queue is processed asynchronously, so we have to drop the exception here
            // Hopefully the real error was already logged (typically a Binance trading issue)
        })
}

// Processes the trade signal and schedules the trade actions
export async function trade(signal: Signal, source: SourceType) {
    // Check if the cache needs to be refreshed, we'll do this asynchronously because we can use the previous set of data now
    refreshMarkets().catch((reason) => {
        logger.silly("trade->refreshMarkets: " + reason)
        // Don't really care if this doesn't work
    })

    // Check that this is a signal we want to process
    const tradingData = checkTradingData(signal, source)

    // Notify of incoming signal that we want to process, we will also send a notification once the trade is executed
    // There is no need to wait for this to finish
    notifyAll(getNotifierMessage(MessageType.INFO, source, signal)).catch((reason) => {
        logger.silly("trade->notifyAll: " + reason)
    })

    let tradeOpen: TradeOpen

    if (tradingData.signal.entryType === EntryType.ENTER) {
        // Calculate the cost and quantity for the new trade
        tradeOpen = await createTradeOpen(tradingData).catch(
            (reason) => {
                logger.silly("trade->createTradeOpen: " + reason)
                return Promise.reject(reason)
            }
        )
    } else {
        // Get previous trade (not even going to test if this was found because we wouldn't have reached here if it wasn't)
        tradeOpen = getTradeOpen(signal)!
        
        // Update buy / sell price based on the signal so that these can be compared for slippage after the trade is executed
        // We won't update the buy / sell times because these will be done accurately when the trade is executed
        tradeOpen.timeUpdated = new Date()
        if (tradingData.signal.positionType == PositionType.SHORT) {
            tradeOpen.priceBuy = tradingData.signal.price
        } else {
            tradeOpen.priceSell = tradingData.signal.price
        }
        // Recalculate the cost for logging, and just in case the close trade fails we will have a more up to date value
        tradeOpen.cost = tradeOpen.quantity.multipliedBy(tradingData.signal.price!)
        saveState("tradesOpen")
    }

    // Create the before / main action / after tasks and add to the trading queue
    scheduleTrade(tradeOpen, tradingData.signal.entryType, source, tradingData.signal)

    // If all went well, update the trade history
    // We need to do this now in the current thread even though the trade hasn't actually been executed yet, because other signals may need to reference it either for closing or auto balancing
    logger.debug(`Were ${tradingMetaData.tradesOpen.length} open trades and ${tradingMetaData.tradesClosing.size} closing trades.`)
    if (tradingData.signal.entryType == EntryType.ENTER) {
        // Add the new opened trade
        tradingMetaData.tradesOpen.push(tradeOpen)
        saveState("tradesOpen")
    }

    // Exit trades will be removed once they have successfully executed in the queue
}

// Schedule the sell commands to rebalance an existing trade to a new cost, also update the current balance in the wallet
function rebalanceTrade(tradeOpen: TradeOpen, cost: BigNumber, wallet: WalletData) {
    if (!tradeOpen.cost) {
        // Hopefully this won't happen
        return `Could not rebalance ${getLogName(tradeOpen)} trade, cost is undefined.`
    }

    if (tradeOpen.borrow && tradeOpen.borrow.isGreaterThan(0)) {
        // Hopefully this won't happen as we shouldn't be rebalancing SHORT trades, and rebalancing model does not borrow for LONG trades
        return `Could not rebalance ${getLogName(tradeOpen)} trade, involves borrowed funds.`
    }

    if (!tradeOpen.priceBuy) {
        // Hopefully this won't happen as all LONG trades should have a purchase price
        return `Could not rebalance ${getLogName(tradeOpen)} trade, no buy price.`
    }

    if (tradeOpen.cost.isLessThanOrEqualTo(cost)) {
        // Maybe the largest trade is already smaller than the free balance, so we're just going to skip
        logger.warn(`Could not rebalance ${getLogName(tradeOpen)} trade, it is already below the target cost.`)
        // Technically this is successful even though it didn't free up any funds
        return
    }

    const market = tradingMetaData.markets[tradeOpen.symbol]

    // Have to set a sell price so that it can update balances
    if (hasCurrentPrices()) {
        // Querying ticker data again will slow down the process, so we'll only use it if we've got it
        tradeOpen.priceSell = tradingMetaData.prices[tradeOpen.symbol]
    }
    // The sell price may have updated from a previous successful rebalance, so we'll keep that for calculating
    if (!tradeOpen.priceSell) tradeOpen.priceSell = tradeOpen.priceBuy

    // Calculate the difference in cost and quantity
    const targetDiffCost = tradeOpen.cost.minus(cost)
    const diffQTY = getLegalQty(targetDiffCost.dividedBy(tradeOpen.priceSell), market, tradeOpen.priceSell)
    // Recalculate the cost as the quantity may have rounded up
    const diffCost = diffQTY.multipliedBy(tradeOpen.priceSell)

    // Make sure any rounding is not taking way more that expected (i.e. more than double)
    if (diffCost.dividedBy(targetDiffCost).isGreaterThan(2)) {
        logger.warn(`Will not rebalance ${getLogName(tradeOpen)} trade because the legal trade cost of ${diffCost} ${market.quote} is much higher than the ${targetDiffCost} ${market.quote} needed.`)
        // Don't want to show this as an error
        return
    }

    // Make sure the rebalance would not close the trade
    if (diffQTY.isGreaterThanOrEqualTo(tradeOpen.quantity)) {
        return `Could not rebalance ${getLogName(tradeOpen)} trade because it would be more than the remaining quantity.`
    }

    // Make sure any rounding doesn't leave us with a trade that is too small
    const remQty = tradeOpen.quantity.minus(diffQTY)
    const legRemQty = getLegalQty(remQty, market, tradeOpen.priceSell)
    if (legRemQty.isGreaterThan(remQty)) {
        return `Could not rebalance ${getLogName(tradeOpen)} trade because the remaining quantity of ${remQty} ${market.base} may be too small to close later.`
    }

    logger.debug(`Rebalancing ${getLogName(tradeOpen)} trade to reduce by ${diffQTY} ${market.base} and ${diffCost} ${market.quote}.`)

    // It is possible that multiple signals for the same coin can come in at the same time
    // So a second trade may try to rebalance the first before the first trade has executed
    if (tradeOpen.isExecuted) {
        // Clone trade just to execute the partial close
        const tmpTrade = {
            ...tradeOpen,
            quantity: diffQTY,
            cost: diffCost
        }

        // Simulate closing the trade, but only for the difference in quantity
        scheduleTrade(tmpTrade, EntryType.EXIT, SourceType.REBALANCE)

        tradeOpen.timeSell = new Date()
    } else {
        // In this case we don't need to sell anything, just adjust the original trade and it should only buy what is allocated
        logger.warn(`${getLogName(tradeOpen)} trade needs to be rebalanced before it was executed, original cost of ${tradeOpen.cost} ${market.quote} will be reduced by ${diffCost}.`)
    }

    // If we got this far then we just have to assume that the rebalance trade will go through ok, so update the original trade
    tradeOpen.quantity = remQty
    tradeOpen.cost = tradeOpen.cost!.minus(diffCost)
    tradeOpen.timeUpdated = new Date()
    saveState("tradesOpen")

    // Adjust wallet balances
    wallet.free = wallet.free.plus(diffCost)
    wallet.locked = wallet.locked.minus(diffCost)
}

// Loads the current free balances for each wallet type and calculates the total value from all open trades
// Also identifies largest and all associated trades for use in rebalancing
async function loadWalletBalances(tradingType: TradingType, market?: Market, quote?: string, wallet?: WalletType): Promise<Dictionary<WalletData>> {
    // These shouldn't happen, but just to be sure
    if (!market && !quote) {
        const logMessage = "Failed to load wallet balances: unknown asset."
        logger.error(logMessage)
        return Promise.reject(logMessage)
    } 
    if (!market && tradingType == TradingType.virtual) {
        const logMessage = "Failed to load wallet balances: Market needed for virtual."
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }

    // Default the quote asset from the market data if not specified
    if (!quote) quote = market!.quote

    const wallets: Dictionary<WalletData> = {}
    if (wallet) {
        // Only check the specified wallet
        wallets[wallet] = new WalletData(wallet)
    } else {
        // We need to calculate ballances for all wallets because we'll pass them into the balance history later
        Object.values(WalletType).forEach(w => wallets[w] = new WalletData(w))
        // Exclude margin if disabled
        if (!env().IS_TRADE_MARGIN_ENABLED) delete wallets[WalletType.MARGIN]
    }

    // Get the available balances of each wallet
    for (let wallet of Object.values(wallets)) {
        if (tradingType == TradingType.real) {
            // Get the current balance from Binance for the base coin (e.g. BTC)
            wallet.free = new BigNumber((await fetchBalance(wallet.type).catch((reason) => {
                logger.silly("createTradeOpen->fetchBalance: " + reason)
                return Promise.reject(reason)
            }))[quote].free) // We're just going to use 'free', but I'm not sure whether 'total' is better
        } else {
            initialiseVirtualBalances(wallet.type, market!)
            wallet.free = tradingMetaData.virtualBalances[wallet.type][quote]
        }
    }

    // Estimate total balances to calculate proportional trades, also subtract committed funds for SHORT trades
    // While we're looping through trades, also keep a few other indicators in case we want auto balancing
    // Only calculate trades that match this trading type (real vs. virtual)
    for (let trade of tradingMetaData.tradesOpen.filter(t => t.tradingType == tradingType)) {
        // Ideally wallet and cost should have been initialised by now (but need to check to satisfy the compiler), also we may not be using one of the wallets for this trade
        if (trade.wallet && trade.cost && wallets[trade.wallet]) {
            // If the existing trade and this new signal share the same quote currency (e.g. both accumulating BTC)
            if (tradingMetaData.markets[trade.symbol].quote == quote) {
                // SHORT trades artificially increase the funds in margin until they are closed, so these need to be subtracted from the free balance
                // Technically we could probably still use it for LONG trades if they were closed before the SHORT trade, but it would be a big gamble
                // We don't exactly know how much will be needed for the SHORT trade, hopefully it is less than the opening price but it could be higher
                // Also, there may be LONG trades that have not yet been processed in the queue so the wallets won't reflect the actual end state when this trade will process
                if ((trade.positionType == PositionType.SHORT && trade.isExecuted) || (trade.positionType == PositionType.LONG && !trade.isExecuted)) {
                    logger.debug(`${trade.cost.toFixed()} ${quote} are allocated to a ${trade.symbol} ${trade.positionType} trade that has ${!trade.isExecuted ? "not " : ""}been executed.`)
                    wallets[trade.wallet].free = wallets[trade.wallet].free.minus(trade.cost)
                }

                // When a SHORT trade is closed it will not increase the balance because the funds are borrowed, so rebalancing can only be done on LONG trades
                // Make sure the trade is not already closing
                if (trade.positionType == PositionType.LONG && !tradingMetaData.tradesClosing.has(trade)) {
                    // Add up all the costs from active LONG trades
                    wallets[trade.wallet].locked = wallets[trade.wallet].locked.plus(trade.cost)

                    // Keep the list of active LONG trades
                    // We still need to include the stopped trades here so we can subtract them from the total later
                    wallets[trade.wallet].trades.push(trade)
                }
            }
            // If there is a different strategy that is using a different quote currency, but with open LONG trades sharing this base currency
            else if (tradingMetaData.markets[trade.symbol].base == quote && trade.positionType == PositionType.LONG && trade.isExecuted) {
                // We cannot use that purchased quantity as part of the balance because it may soon be sold
                logger.debug(`${trade.quantity.toFixed()} ${quote} are allocated to a ${trade.symbol} ${trade.positionType} trade that has been executed.`)
                wallets[trade.wallet].free = wallets[trade.wallet].free.minus(trade.quantity)
            }
        }
    }

    // Check for any trades that are about to close, and make sure the funds are allocated in advance
    for (let trade of tradingMetaData.tradesClosing) {
        // We don't care about SHORT trades because we checked sold above and whatever we buy we don't keep anyway (only the profits which we can't guarantee)
        // Also, there is a slight possibility that the trade will try to open and close before executing, these can be ignored because the balance won't change
        if (trade.cost && trade.wallet && wallets[trade.wallet] && trade.positionType == PositionType.LONG && trade.isExecuted) {
            // If sharing the same quote currency, this could be normal trades or rebalancing trades
            if (tradingMetaData.markets[trade.symbol].quote == quote) {
                logger.debug(`${trade.cost.toFixed()} ${quote} will be released by a ${trade.symbol} ${trade.positionType} trade that is waiting to sell.`)
                // Assume the trade will be successful and free up the funds before this new one
                wallets[trade.wallet].free = wallets[trade.wallet].free.plus(trade.cost)
            } else if (tradingMetaData.markets[trade.symbol].base == quote && !tradingMetaData.tradesOpen.includes(trade)) {
                // Rebalancing trades aren't in the main set so we didn't see them above, but they could also be trying to sell the base currency too
                logger.debug(`${trade.quantity.toFixed()} ${quote} are allocated to a ${trade.symbol} ${trade.positionType} trade that is waiting to sell.`)
                wallets[trade.wallet].free = wallets[trade.wallet].free.minus(trade.quantity)
            }
        }
    }

    // Calculate wallet totals and subtract the buffer
    let totalBalance = new BigNumber(0)
    for (const wallet of Object.values(wallets)) {
        wallet.total = wallet.free.plus(wallet.locked)
        totalBalance = totalBalance.plus(wallet.total)

        let logMessage = `Actual ${wallet.type} total of ${wallet.total} ${quote} is made up of ${wallet.free.toFixed()} free and ${wallet.locked.toFixed()} locked`
        // If not called from an opening trade then we won't apply the buffer
        if (market && env().WALLET_BUFFER) {
            const buffer = wallet.total.multipliedBy(env().WALLET_BUFFER)
            wallet.free = wallet.free.minus(buffer)
            wallet.total = wallet.total.minus(buffer)
            logMessage += ` with a buffer of ${buffer}`
        }
        logger.debug(`${logMessage}.`)
    }

    // If not called from an opening trade then there will be no market data, so may not be a quote asset we're tracking
    // Also only want to update balances when all wallets have been loaded
    if (market && !wallet) {
        // We only look at the balances when opening a trade, so keep them for the history
        // Don't send the entry type because it will be called again when the trade executes
        updateBalanceHistory(tradingType, quote, undefined, totalBalance)
    }

    return Promise.resolve(wallets)
}

// Calculates the profit and loss between two prices including fees, returns as a percentage
export function calculatePnL(priceBuy: BigNumber, priceSell: BigNumber): BigNumber {
    // Need to apply fees to both the buy and sell price to ensure overall profit or loss is calculated
    const buyFee = 1 + (env().TAKER_FEE_PERCENT / 100)
    const sellFee = 1 - (env().TAKER_FEE_PERCENT / 100)

    return priceSell.multipliedBy(sellFee).minus(priceBuy.multipliedBy(buyFee)).dividedBy(priceBuy.multipliedBy(buyFee)).multipliedBy(100)
}

// Calculates the trade quantity, cost, and amount to borrow based on available funds and the configured funding model
// This may initiate rebalancing trades to free up necessary funds
async function calculateTradeSize(tradingData: TradingData, wallets: Dictionary<WalletData>, preferred: WalletType[], primary: WalletType): Promise<{ quantity: BigNumber; cost: BigNumber; borrow: BigNumber; wallet: WalletType }> {
    // Start with the default quantity to spend (cost) as entered into NBT Hub
    let cost = tradingData.strategy.tradeAmount // The amount of the quote coin to trade (e.g. BTC for ETHBTC)
    let quantity = new BigNumber(0) // The amount of the base coin to trade (e.g. ETH for ETHBTC)
    let borrow = new BigNumber(0) // The amount of either the base (for SHORT) or quote (for LONG) that needs to be borrowed

    // See if the cost should be converted to a fraction of the balance
    if (env().IS_BUY_QTY_FRACTION) {
        // Check that the quantity can actually be used as a fraction
        if (cost.isGreaterThan(1)) {
            const logMessage = `Failed to trade as quantity to spend is not a valid fraction: ${cost.toFixed()}.`
            logger.error(logMessage)
            return Promise.reject(logMessage)
        }

        // Calculate the fraction of the total balance
        cost = wallets[primary].total.multipliedBy(cost)
        logger.debug(`Total usable ${primary} wallet is ${wallets[primary].total.toFixed()} so target trade cost will be ${cost.toFixed()} ${tradingData.market.quote}.`)
    }

    // Ensure that we have a valid quantity and cost to start with, especially if we are going to borrow to make this trade
    quantity = getLegalQty(cost.dividedBy(tradingData.signal.price!), tradingData.market, tradingData.signal.price!)
    cost = quantity.multipliedBy(tradingData.signal.price!)
    logger.debug(`Legal target trade cost is ${cost} ${tradingData.market.quote}.`)

    switch (tradingData.signal.positionType) {
        case PositionType.LONG:
            // Calculate the cost for LONG trades based on the configured funding model
            const model: LongFundsType = env().TRADE_LONG_FUNDS
            if (model == LongFundsType.BORROW_ALL && tradingData.market.margin) {
                // Special case for always borrowing for LONG trades regardless of whether you could fund it yourself
                borrow = cost
            } else {
                // Find the best wallet based on free funds
                let use = getBestWallet(cost, preferred, wallets)
                // Check if we can just trade the full amount outright
                if (cost.isGreaterThan(use.free)) {
                    // Otherwise, work out how to fund it
                    switch (model) {
                        case LongFundsType.NONE:
                            // Purchase whatever we can, will check if this is valid later
                            cost = use.free
                            break
                        case LongFundsType.BORROW_MIN:
                        case LongFundsType.BORROW_ALL: // This is the fallback option, the preferred model is above
                            // Not enough free, so force to use margin wallet and buy the remainder (if we can)
                            if (tradingData.market.margin) {
                                use = wallets[WalletType.MARGIN]
                                // Sometimes the wallet buffer makes the free amount look negative
                                if (use.free.isGreaterThan(0)) {
                                    borrow = cost.minus(use.free)
                                } else {
                                    // So we don't want to borrow more than the trade cost
                                    borrow = cost
                                }
                            } else {
                                // Margin is not supported, so just trade whatever we can, will check if it is valid later
                                cost = use.free
                            }
                            break
                        case LongFundsType.SELL_ALL:
                        case LongFundsType.SELL_LARGEST:
                        case LongFundsType.SELL_LARGEST_PNL:
                            // Get the latest prices only if we know they are needed
                            if (env().IS_FUNDS_NO_LOSS || env().TRADE_LONG_FUNDS == LongFundsType.SELL_LARGEST_PNL) {
                                await refreshPrices().catch((reason) => {
                                    logger.silly("calculateTradeSize->refreshPrices: " + reason)
                                    return Promise.reject(reason)
                                })
                            }

                            // Calculate the potential for each wallet
                            for (let wallet of Object.values(wallets)) {
                                const excluded: TradeOpen[] = []
                                for (const trade of wallet.trades) {
                                    if (trade.isStopped) {
                                        // Exclude any stopped trades as these cannot be rebalanced
                                        logger.debug(`${getLogName(trade)} trade is stopped so will not be used for rebalancing.`)
                                        excluded.push(trade)
                                    } else if (trade.isHodl && !env().IS_FUNDS_NO_LOSS) {
                                        // If we're not going to check for profitable trades before rebalancing, then just have to assume HODL trades will lose
                                        logger.debug(`${getLogName(trade)} trade is set to HODL so will not be used for rebalancing.`)
                                        excluded.push(trade)
                                    } else if (trade.quantity.isLessThan(tradingMetaData.markets[trade.symbol].limits.amount.min*2) || trade.cost!.isLessThan(getMinCost(tradingMetaData.markets[trade.symbol]).multipliedBy(2))) {
                                        // If the quantity or cost cannot be divided into two minimum trades then it is already too small
                                        logger.debug(`${getLogName(trade)} trade is already too small to be used for rebalancing.`)
                                        excluded.push(trade)
                                    }
                                }
                                // Deduct excluded costs and remove trades from the wallet
                                for (const trade of excluded) {
                                    wallet.total = wallet.total.minus(trade.cost!)
                                }
                                wallet.trades = wallet.trades.filter(trade => !excluded.includes(trade))
                                
                                if (env().IS_FUNDS_NO_LOSS) {
                                    // Find only the trades that are expected to not make a loss if we sell them now
                                    const profitTrades: TradeOpen[] = []
                                    for (const trade of wallet.trades) {
                                        // Calculate the difference in price since opening the LONG trade
                                        // Prices should already have been refreshed when the open signal was received
                                        // The price difference won't be exactly right because we're not looking at the market ask price, but hopefully it is close enough
                                        const percent = calculatePnL(trade.priceBuy!, tradingMetaData.prices[trade.symbol])
                                        // Do not sell for a loss, but can break even
                                        if (percent.isGreaterThanOrEqualTo(0)) {
                                            profitTrades.push(trade)
                                        } else {
                                            logger.debug(`${getLogName(trade)} price has changed from ${trade.priceBuy!.toFixed()} to ${tradingMetaData.prices[trade.symbol].toFixed()}, loss would be ${percent.toFixed(3)}% with fees, so it will not be used for rebalancing.`)
                                            wallet.total = wallet.total.minus(trade.cost!)
                                        }
                                    }

                                    if (wallet.trades.length && !profitTrades.length) {
                                        // Even if this wallet is not chosen, it has open trades so we will still report it
                                        logger.info(`Cannot use any trades in ${wallet.type} for rebalancing as they would each make a loss if sold now.`)
                                    }

                                    // Replace the list of trades for the wallet
                                    wallet.trades = profitTrades
                                }

                                // Find the largest active LONG trade
                                let largest: TradeOpen | undefined = undefined
                                for (const trade of wallet.trades) {
                                    // TODO: It would be nice to use current market price instead of cost calculated from opening price
                                    if (trade.cost && (largest == undefined || trade.cost.isGreaterThan(largest.cost!))) {
                                        largest = trade
                                    }
                                }

                                // If there is nothing to rebalance, or the largest trade is already less than the free balance, then there is no point reducing anything
                                if (!largest || wallet.free.isGreaterThanOrEqualTo(largest.cost!)) {
                                    if (largest) logger.debug(`Free ${tradingData.market.quote} amount on ${wallet.type} is already more than the cost of the largest trade.`)
                                    wallet.potential = wallet.free
                                    // Clear the trades so that we don't try to rebalance anything later
                                    wallet.trades = []
                                } else {
                                    if (model == LongFundsType.SELL_ALL || model == LongFundsType.SELL_LARGEST_PNL) {
                                        // All trades may not have equivalent costs, due to the fact that we don't re-buy remaining trades after one is closed, i.e. new trades can use the full free balance
                                        // So we have to go through and work out which of the highest trades need to be rebalanced so that the new trade is of equal cost to at least one other
                                        // Even for Sell Largest PnL we will only consider trades that are above the average size, this ensures that we still get some balance in the trade sizes
                                        let smaller = true
                                        // Loop through and kick out any trades that are smaller than the average, keep going until we have the exact set of trades to rebalance and the average of just those trades
                                        while (smaller) {
                                            smaller = false
                                            // Calculate the average trade size of the remaining trades and assuming the free balance will also be a trade
                                            wallet.potential = wallet.total.dividedBy(wallet.trades.length + 1)
                                            // Note we're going to overwrie the total and trades for this wallet because it is easier for processing, we shouldn't need the originals anymore
                                            wallet.total = new BigNumber(0)
                                            const largeTrades: TradeOpen[] = []
                                            for (const trade of wallet.trades) {
                                                if (trade.cost!.isGreaterThanOrEqualTo(wallet.potential!)) {
                                                    largeTrades.push(trade)
                                                    // Keep a new total of only the large trades to calculate a new average
                                                    wallet.total = wallet.total.plus(trade.cost!)
                                                } else {
                                                    // This trade is below the average, so it won't get rebalanced
                                                    logger.debug(`${getLogName(trade)} cost of ${trade.cost?.toFixed()} is below the average of ${wallet.potential.toFixed()} so won't be rebalanced.`)
                                                    // The list of trades is different, so we'll need to loop again and calculate a new average
                                                    smaller = true
                                                }
                                            }
                                            // Add the usable free balance back to the remaining total trades
                                            wallet.total = wallet.total.plus(wallet.free)
                                            // Keep the remaining list of large trades
                                            wallet.trades = largeTrades
                                        }

                                        if (model == LongFundsType.SELL_LARGEST_PNL) {
                                            // Now work out which of the largest trades has the best PnL
                                            let best: BigNumber | null = null
                                            for (const trade of wallet.trades) {
                                                // Calculate the relative change in price since opening the LONG trade
                                                // Prices should already have been refreshed when the open signal was received
                                                // The price difference won't be exactly right because we're not looking at the market ask price, but it is all relative
                                                const percent = calculatePnL(trade.priceBuy!, tradingMetaData.prices[trade.symbol])
                                                logger.debug(`${getLogName(trade)} price has changed from ${trade.priceBuy!.toFixed()} to ${tradingMetaData.prices[trade.symbol].toFixed()} (${percent.toFixed(3)}% with fees).`)
                                                if (best == null || percent.isGreaterThan(best)) {
                                                    // Replace the largest trade, the wallet potential will be recalculated later
                                                    largest = trade
                                                    best = percent
                                                }
                                            }
                                        }
                                    }
                                    
                                    if (model == LongFundsType.SELL_LARGEST || model == LongFundsType.SELL_LARGEST_PNL) {
                                        // Using half of the largest trade plus the free balance, both trades should then be equal
                                        // This may not halve the largest trade, it might only take a piece
                                        wallet.potential = wallet.free.plus(largest.cost!).dividedBy(2)
                                        // Overwrite the list of trades to make it easier for rebalancing later, we shouldn't need the original anymore
                                        wallet.trades = [largest]
                                    }
                                }
                            }

                            // Get the best wallet based on the new potential
                            use = getBestWallet(cost, preferred, wallets)
                            // Maybe rebalancing could give us more than we need for this trade, e.g. if we have more than the maximum trade volume
                            if (use.potential!.isLessThan(cost)) cost = use.potential!

                            if (use.trades.length) {
                                logger.info(`Attempting to rebalance ${use.trades.length} existing trade(s) on ${use.type} to ${use.potential?.toFixed()} ${tradingData.market.quote}.`)

                                // Check for the minimum cost here as we don't want to start rebalancing if we can't make the trade
                                if (cost.isLessThan(getMinCost(tradingData.market))) {
                                    const logMessage = `Failed to trade as rebalancing to free up ${cost.toFixed()} ${tradingData.market.quote} would be less than the minimum trade cost of ${getMinCost(tradingData.market).toFixed()} ${tradingData.market.quote}.`
                                    logger.error(logMessage)
                                    return Promise.reject(logMessage)
                                }

                                // Rebalance all the remaining trades in this wallet to the calculated trade size
                                for (let trade of use.trades) {
                                    const reason = rebalanceTrade(trade, use.potential!, use)
                                    if (reason) {
                                        // Not actually going to stop processing, we may still be able to make the trade using the free balance, so just log the error
                                        logger.error(reason)
                                    }
                                }

                                // Just to be sure, let's check the free balance again, this will probably always happen due to rounding
                                if (use.free.isLessThan(cost)) {
                                    // To limit spamming the logs, we'll only warn if there was more than 5% change
                                    if (use.free.multipliedBy(1.05).isLessThan(cost)) {
                                        logger.warn(`Rebalancing calculated a lower trade of only ${use.free.toFixed()} ${tradingData.market.quote} instead of ${cost.toFixed()} ${tradingData.market.quote}.`)
                                    }
                                    cost = use.free
                                }
                            } else {
                                logger.debug(`No ${tradingData.market.quote} trades to be rebalanced, so just using the available amount of ${cost.toFixed()} instead.`)
                            }
                            break
                    }

                    logger.debug(`${getLogName(tradingData.signal)} trade can use ${cost} ${tradingData.market.quote}.`)

                    // As cost probably changed, check for the minimum cost to see if we can make the trade
                    if (cost.isLessThan(getMinCost(tradingData.market))) {
                        const logMessage = `Failed to trade as available ${use.type} funds of ${cost.toFixed()} ${tradingData.market.quote} would be less than the minimum trade cost of ${getMinCost(tradingData.market).toFixed()} ${tradingData.market.quote}.`
                        logger.error(logMessage)
                        return Promise.reject(logMessage)
                    }

                    // Recalculate the purchase quantity based on the new cost
                    quantity = getLegalQty(cost.dividedBy(tradingData.signal.price!), tradingData.market, tradingData.signal.price!)
                    // Recalculate the cost again because the quantity may have been rounded up to the minimum, it may also cause it to drop below the minimum cost due to precision
                    // Note this may result in the trade failing due to insufficient funds, but hopefully the buffer will compensate
                    cost = quantity.multipliedBy(tradingData.signal.price!)
                }
                // Remember the wallet for recording in the trade
                preferred = [use.type]
            }
            break
        case PositionType.SHORT:
            // Need to borrow the full amount that will be sold
            borrow = quantity
            break
    }

    if (!cost.isGreaterThan(0)) {
        // Something is wrong, maybe the wallet buffer, hopefully this won't happen
        const logMessage = `Failed to trade as cost is invalid.`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }

    // Success
    return Promise.resolve({
        quantity,
        cost,
        borrow,
        wallet: preferred[0]
    })
}

// Calculates the trade quantity/cost for an open trade signal based on the user configuration, then generates a new TradeOpen structure
async function createTradeOpen(tradingData: TradingData): Promise<TradeOpen> {
    // User may set the trade amount to zero if they don't want new trades to open, but still want existing trades to close normally
    if (!tradingData.strategy.tradeAmount.isGreaterThan(0)) {
        const logMessage = `Failed to trade as the trade amount is invalid for this ${getLogName(tradingData.strategy)} strategy.`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }

    // Initialise all wallets
    let {preferred, primary} = getPreferredWallets(tradingData.market, tradingData.signal.positionType)
    if (!preferred.length) {
        const logMessage = `Failed to trade as there are no potential wallets to use for this ${getLogName(tradingData.signal)} signal.`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }

    // Calculate the total balances and other data for each wallet type
    const wallets = await loadWalletBalances(tradingData.strategy.tradingType, tradingData.market).catch((reason) => {
        logger.silly("createTradeOpen->loadWalletBalances: " + reason)
        return Promise.reject(reason)
    })

    // Calculate the trade size and selected wallet based on the configured funding model, may initiate rebalancing
    const {quantity, cost, borrow, wallet} = await calculateTradeSize(tradingData, wallets, preferred, primary).catch((reason) => {
        logger.silly("createTradeOpen->calculateTradeSize: " + reason)
        return Promise.reject(reason)
    })

    let msg = `${getLogName(tradingData.signal)} trade will be executed on ${wallet}, total of ${quantity.toFixed()} ${tradingData.market.base} for ${cost.toFixed()} ${tradingData.market.quote}.`
    if (borrow.isGreaterThan(0)) {
        msg += ` Also need to borrow ${borrow} ${tradingData.signal.positionType == PositionType.LONG ? tradingData.market.quote : tradingData.market.base}.`
    }
    logger.info(msg)

    // Create the new trade
    return Promise.resolve({
        id: newTradeID(), // Generate a temporary internal ID, because we only get one from the NBT Hub when reloading the payload
        isStopped: false,
        isHodl: false,
        positionType: tradingData.signal.positionType!,
        tradingType: tradingData.strategy.tradingType,
        priceBuy: tradingData.signal.positionType == PositionType.LONG ? tradingData.signal.price : undefined,
        priceSell: tradingData.signal.positionType == PositionType.SHORT ? tradingData.signal.price : undefined,
        quantity,
        cost,
        borrow,
        wallet,
        strategyId: tradingData.signal.strategyId,
        strategyName: tradingData.signal.strategyName,
        symbol: tradingData.signal.symbol,
        timeUpdated: new Date(),
        timeBuy: undefined, // This will be set when the trade is executed
        timeSell: undefined, // This will be set when the trade is executed
        isExecuted: false
    })
}

// Generate a shortened MD5 hash of a UUID
function newTradeID(): string {
    var md5sum = crypto.createHash('md5');
    md5sum.update(uuidv4());
    // 12 characters should still be unique enough for our purposes
    return md5sum.digest('hex').substr(0, 12)
}

// Get the list of wallets that are applicable for the market and trade position, sorted by priority
function getPreferredWallets(market: Market, positionType = PositionType.LONG) {
    const primary = env().PRIMARY_WALLET.toLowerCase() as WalletType // Primary wallet for reference balance
    let preferred: WalletType[] = [WalletType.MARGIN] // Available wallets for this trade, sorted by priority, default to margin

    // Check which wallets can be used for this trade, SHORT will always be margin
    if (positionType == PositionType.LONG) {
        // Start with the primary wallet for LONG trades
        preferred[0] = primary
        // Check primary wallet can actually be used for this trade
        if (!market[primary]) preferred.pop()
        // Add all the other types that can be used
        Object.values(WalletType).filter(w => w != primary && market[w]).forEach(w => preferred.push(w))
    }

    // Remove margin if disabled
    if (!env().IS_TRADE_MARGIN_ENABLED) {
        preferred = preferred.filter(w => w != WalletType.MARGIN)
    }

    logger.debug(`Identified ${preferred.length} potential wallet(s) to use for a ${market.symbol} trade, ${preferred[0]} is preferred.`)

    return { preferred, primary }
}

// Out of a prioritised list of wallets, find the one with the most free funds to make the trade
function getBestWallet(cost: BigNumber, preferred: WalletType[], wallets: Dictionary<WalletData>): WalletData {
    const walletMap = preferred.map(w => wallets[w])
    let largest = walletMap[0]
    for (let wallet of walletMap) {
        // Default potential to free
        if (wallet.potential == undefined) wallet.potential = wallet.free

        // First see if any have the complete balance
        if (wallet.potential.isGreaterThanOrEqualTo(cost)) return wallet

        // Otherwise keep the one with the largest balance
        if (wallet.potential.isGreaterThan(largest.potential!)) largest = wallet
    }

    return largest
}

// Clears all virtual balances and corresponding balance history, then initialises balances from open trades
export function resetVirtualBalances(virtualTrades?: TradeOpen[]) {
    // Set up virtual wallets
    Object.values(WalletType).forEach(wallet => tradingMetaData.virtualBalances[wallet] = {})
    if (Object.keys(tradingMetaData.balanceHistory).includes(TradingType.virtual)) {
        delete tradingMetaData.balanceHistory[TradingType.virtual]
        saveState("balanceHistory")
    }

    if (!virtualTrades) {
        virtualTrades = tradingMetaData.tradesOpen.filter(trade => trade.tradingType == TradingType.virtual)
    }

    for (const trade of virtualTrades) {
        const market = tradingMetaData.markets[trade.symbol]
        initialiseVirtualBalances(trade.wallet!, market)
        switch (trade.positionType) {
            case PositionType.SHORT:
                // We've already borrowed and sold the asset, so we should have surplus funds
                tradingMetaData.virtualBalances[trade.wallet!][market.quote] = tradingMetaData.virtualBalances[trade.wallet!][market.quote].plus(trade.cost!)
                break
            case PositionType.LONG:
                // We've already bought the asset, so we should have less funds
                tradingMetaData.virtualBalances[trade.wallet!][market.base] = tradingMetaData.virtualBalances[trade.wallet!][market.base].plus(trade.quantity!)
                tradingMetaData.virtualBalances[trade.wallet!][market.quote] = tradingMetaData.virtualBalances[trade.wallet!][market.quote].minus(trade.cost!)
                // TODO: It would be better to rebalance the virtual trades to keep the defined open balance, but that will take some work
                if (tradingMetaData.virtualBalances[trade.wallet!][market.quote].isLessThan(0)) tradingMetaData.virtualBalances[trade.wallet!][market.quote] = new BigNumber(0)
                break
        }
    }

    saveState("virtualBalances")
}

// Initialise the virtual balances if not already used for these coins
// Note, If you have different strategies using different quote assets but actively trading in each other's asset, one of them may miss out on the initial balance
function initialiseVirtualBalances(walletType: WalletType, market: Market) {
    if (tradingMetaData.virtualBalances[walletType][market.base] == undefined) {
        tradingMetaData.virtualBalances[walletType][market.base] = new BigNumber(0) // Start with zero base (e.g. ETH for ETHBTC)
        saveState("virtualBalances")
    }
    if (tradingMetaData.virtualBalances[walletType][market.quote] == undefined) {
        let value = virtualWalletFunds
        const btc = tradingMetaData.markets[env().REFERENCE_SYMBOL]
        // If the quote asset is not BTC, then use the minimum costs to scale the opening balance
        if (market.quote != "BTC" && market.limits.cost && btc && btc.limits.cost) {
            value = value.dividedBy(btc.limits.cost.min).multipliedBy(market.limits.cost.min)
            logger.debug(`Calculated virtual opening balance of ${value} ${market.quote} on ${walletType}.`)
            if (!value.isGreaterThan(0)) value = virtualWalletFunds // Just in case
        }
    
        tradingMetaData.virtualBalances[walletType][market.quote] = value // Start with the default balance for quote (e.g. BTC for ETHBTC)
        saveState("virtualBalances")
    }
}

// Just clears the Balance History for a given coin, will clear both real and virtual if trading type is not specified
export function deleteBalanceHistory(asset: string, tradingType?: TradingType): string[] {
    const result: string[] = []
    for (let tt of Object.keys(tradingMetaData.balanceHistory)) {
        if (!tradingType || tt == tradingType) {
            if (asset in tradingMetaData.balanceHistory[tt]) {
                delete tradingMetaData.balanceHistory[tt][asset]
                result.push(tt)
            }
        }
    }
    if (result.length) saveState("virtualBalances")
    return result
}

// Updates the running balance for the current day
function updateBalanceHistory(tradingType: TradingType, quote: string, entryType?: EntryType, balance?: BigNumber, change?: BigNumber, fee?: BigNumber) {
    if (!Object.keys(tradingMetaData.balanceHistory).includes(tradingType)) tradingMetaData.balanceHistory[tradingType] = {}
    if (!Object.keys(tradingMetaData.balanceHistory[tradingType]).includes(quote)) tradingMetaData.balanceHistory[tradingType][quote] = []

    // Get last history slice
    let h = tradingMetaData.balanceHistory[tradingType][quote].slice(-1).pop()
    if (!h && !balance) {
        // This usually happens when the trader is restarted with existing open trades, and a close signal comes through first
        logger.error(`No previous balance history for ${tradingType} ${quote}, cannot track this change.`)
        return
    }
    if (!balance) {
        // Copy the closing balance from the previous day
        balance = h!.closeBalance
    }

    // Initialise a history object here so that the timestamp is locked
    const tmpH = new BalanceHistory(balance)

    // Check if existing balance history is still the same date
    if (!h || h.date.getTime() != tmpH.date.getTime()) {
        tradingMetaData.balanceHistory[tradingType][quote].push(tmpH)
        h = tmpH
    }

    // Calculate number of concurrent open trades
    // This method should only be called with a signal after the trade has executed, so it would have been removed on closing
    // It may be called without a signal for setting the opening balance or auto balancing trades, so trade count won't be affected
    // If called for setting the openening balance it will be before the trade is added, which is fine because it may not execute
    const maxOpenTradeCount = tradingMetaData.tradesOpen.filter(trade => trade.tradingType == tradingType && tradingMetaData.markets[trade.symbol].quote == quote).length + (entryType == EntryType.EXIT ? 1 : 0)
    // Unless this fires on exactly midnight, there must have been a time before or after this trade without it
    const minOpenTradeCount = maxOpenTradeCount - (entryType ? 1 : 0)
    
    // Update latest balances and stats
    if (change) balance = balance.plus(change)
    if (fee) h.estimatedFees = h.estimatedFees.plus(fee)
    h.closeBalance = balance
    h.profitLoss = h.closeBalance.minus(h.openBalance).plus(h.estimatedFees)
    if (h.minOpenTrades == undefined || minOpenTradeCount < h.minOpenTrades) h.minOpenTrades = minOpenTradeCount
    if (h.maxOpenTrades == undefined || maxOpenTradeCount > h.maxOpenTrades) h.maxOpenTrades = maxOpenTradeCount
    if (entryType == EntryType.ENTER) {
        h.totalOpenedTrades++
    } else if (entryType == EntryType.EXIT) {
        h.totalClosedTrades++
    }

    // Remove previous history slices that are older than 1 year, but keep the very first entry for lifetime opening balance
    const lastYear = new Date(tmpH.date.getFullYear()-1, tmpH.date.getMonth(), tmpH.date.getDate()).getTime()
    let fees = new BigNumber(tradingMetaData.balanceHistory[tradingType][quote][0].estimatedFees)
    while (tradingMetaData.balanceHistory[tradingType][quote].length > 1 && tradingMetaData.balanceHistory[tradingType][quote][1].date.getTime() <= lastYear) {
        // As we need to sum the fees from the history to calculate PnL, we need to keep any fees that we delete
        fees = fees.plus(tradingMetaData.balanceHistory[tradingType][quote][1].estimatedFees)
        tradingMetaData.balanceHistory[tradingType][quote].splice(1, 1)
    }
    tradingMetaData.balanceHistory[tradingType][quote][0].estimatedFees = fees

    saveState("balanceHistory")
}

// Constructs a consistent name for trades, signals, and strategies for logging
function getLogName(source: TradeOpen | Signal | Strategy) {
    // Hack to restore original types because when they reload from JSON they just end up as objects
    if (Object.getPrototypeOf(source) == Object.prototype) {
        if (source.hasOwnProperty("strategyName")) {
            if (source.hasOwnProperty("tradingType")) {
                // Must be a TradeOpen
                Object.setPrototypeOf(source, TradeOpen.prototype)
            } else {
                // Must be a Signal
                Object.setPrototypeOf(source, Signal.prototype)
            }
        } else if (source.hasOwnProperty("tradingType")) {
            // Must be a Strategy
            Object.setPrototypeOf(source, Strategy.prototype)
        }
    }

    if (source instanceof TradeOpen) {
        return `${source.strategyId} "${source.strategyName}" ${source.tradingType ? source.tradingType : ""} ${source.symbol} ${source.positionType}`
    } else if (source instanceof Signal) {
        return `${source.strategyId} "${source.strategyName}" ${source.symbol} ${source.positionType ? source.positionType : ""}`
    } else if (source instanceof Strategy) {
        return `${source.id} "${source.name}" ${source.tradingType}`
    }

    return "[ERROR]: " + Object.getPrototypeOf(source)
}

export function getTradeOpen(match: Signal | TradeOpen): TradeOpen | undefined {
    const tradesOpenFiltered = getTradeOpenFiltered(match, tradingMetaData.tradesOpen)

    if (tradesOpenFiltered.length == 0) {
        logger.debug(`No open trade found for ${getLogName(match)}.`)
    } else if (tradesOpenFiltered.length > 1) {
        if (match.positionType) {
            // Hopefully this won't happen
            logger.warn(`There is more than one trade open for ${getLogName(match)}. Using the first found.`)
            return tradesOpenFiltered[0]
        } else {
            // This happens when you try to manually close a trade from the NBT Hub while both a short and long are open for the same strategy and symbol
            // You'll have to close the right one from the trader web interface
            logger.error(`There is more than one trade open for ${getLogName(match)}. The signal did not include a position type.`)
        }
    } else {
        logger.silly(`Exactly one open trade found for ${getLogName(match)}.`)
        return tradesOpenFiltered[0]
    }
}

export function getTradeOpenFiltered(match: Signal | TradeOpen, trades: TradeOpen[]): TradeOpen[] {
    return trades.filter(
        (tradeOpen) =>
            tradeOpen.strategyId === match.strategyId &&
            tradeOpen.symbol === match.symbol &&
            (match.positionType
                ? tradeOpen.positionType === match.positionType
                : true) // If the input contains a position type, then the open trade must match that.
    )
}

// Removes the trade from the open trades meta data
function removeTradeOpen(tradeOpen: TradeOpen) {
    tradingMetaData.tradesOpen =
        tradingMetaData.tradesOpen.filter(
            (tradesOpenElement) =>
                tradesOpenElement !== tradeOpen
        )
    saveState("tradesOpen")
}

// Used by the web server to allow users to delete trades manually
export function deleteTrade(tradeId: string): string | undefined {
    const tradeOpen = tradingMetaData.tradesOpen.find(trade => trade.id == tradeId)
    if (tradeOpen) {
        logger.info(`Deleting ${getLogName(tradeOpen)} trade.`)
        removeTradeOpen(tradeOpen)
        return getLogName(tradeOpen)
    }
}

// Used by the web server to allow users to stop and start trades manually
export function setTradeStopped(tradeId: string, stop: boolean): string | undefined {
    const tradeOpen = tradingMetaData.tradesOpen.find(trade => trade.id == tradeId)
    if (tradeOpen) {
        if (stop) {
            logger.info(`Stopping ${getLogName(tradeOpen)} trade.`)
        } else {
            logger.info(`Resuming ${getLogName(tradeOpen)} trade.`)
        }
        tradeOpen.isStopped = stop
        saveState("tradesOpen")
        return getLogName(tradeOpen)
    }
}

// Used by the web server to allow users to enable or disable HODL on a trade
export function setTradeHODL(tradeId: string, hodl: boolean): string | undefined {
    const tradeOpen = tradingMetaData.tradesOpen.find(trade => trade.id == tradeId)
    if (tradeOpen) {
        if (hodl) {
            logger.info(`HODL ${getLogName(tradeOpen)} trade.`)
        } else {
            logger.info(`Release HODL on ${getLogName(tradeOpen)} trade.`)
        }
        tradeOpen.isHodl = hodl
        saveState("tradesOpen")
        return getLogName(tradeOpen)
    }
}

// Used by the web server to allow users to stop and start strategies manually
export function setStrategyStopped(stratId: string, stop: boolean): string | undefined {
    const strategy = tradingMetaData.strategies[stratId]
    if (strategy) {
        if (stop) {
            logger.info(`Stopping ${getLogName(strategy)} strategy.`)
        } else {
            logger.info(`Resuming ${getLogName(strategy)} strategy.`)
            strategy.lossTradeRun = 0
        }
        strategy.isStopped = stop
        saveState("strategies")
        return getLogName(strategy)
    }
}

// Gets a count of the open active trades for a given position type, and also within the same real/virtual trading
// Doesn't count stopped or count HODL trades
function getOpenTradeCount(positionType: PositionType, tradingType: TradingType) {
    return tradingMetaData.tradesOpen.filter(
        (tradeOpen) =>
            tradeOpen.positionType === positionType &&
            !tradeOpen.isStopped && !tradeOpen.isHodl &&
            tradeOpen.tradingType == tradingType
    ).length
}

// Gets all open trades for a strategy that are not stopped or HODL
function getStratOpenTrades(strategy: Strategy): TradeOpen[] {
    return tradingMetaData.tradesOpen.filter(trade => trade.strategyId == strategy.id && !trade.isStopped && !trade.isHodl)
}

// Returns the minimum trade cost with buffer applied for slippage
function getMinCost(market: Market): BigNumber {
    if (market.limits.cost) {
        // Increase the minimum cost by the buffer fraction
        return new BigNumber(market.limits.cost.min).multipliedBy(1 + env().MIN_COST_BUFFER)
    }
    return new BigNumber(0)
}

// Ensures that the order quantity is within the allowed limits and precision
// https://ccxt.readthedocs.io/en/latest/manual.html#precision-and-limits
function getLegalQty(qty: BigNumber, market: Market, price: BigNumber): BigNumber {
    // Check min and max order quantity
    if (qty.isLessThan(market.limits.amount.min)) {
        qty = new BigNumber(market.limits.amount.min)
        logger.debug(`${market.symbol} trade quantity is below the minimum.`)
    }
    if (market.limits.amount.max && qty.isGreaterThan(market.limits.amount.max)) {
        qty = new BigNumber(market.limits.amount.max)
        logger.debug(`${market.symbol} trade quantity is above the maximum.`)
    }
    const limits: any = market.limits // Need this to get to the hidden property
    if (limits.market && limits.market.max && qty.isGreaterThan(limits.market.max)) {
        qty = new BigNumber(limits.market.max)
        logger.debug(`${market.symbol} trade quantity is above the market maximum.`)
    }

    // We're generally using market price, so no need to check that
    //Order price >= limits['min']['price']
    //Order price <= limits['max']['price']
    //Precision of price must be <= precision['price']

    if (market.limits.cost) {
        let cost = qty.multipliedBy(price)
        const minCost = getMinCost(market)
        if (cost.isLessThan(minCost)) {
            qty = minCost.dividedBy(price)
            logger.debug(`${market.symbol} trade cost is below the minimum.`)
        }

        // Technically the cost might have changed, but it is unlikely to have gone above the max, so no need to recalculate
        if (market.limits.cost.max && cost.isGreaterThan(market.limits.cost.max)) {
            qty = new BigNumber(market.limits.cost.max).dividedBy(price)
            logger.debug(`${market.symbol} trade cost is above the maximum.`)
        }

        // Precision can cause the quantity to truncate and drop below the minimum again, so calculate and test
        qty = amountToPrecision(market.symbol, qty)
        cost = qty.multipliedBy(price)
        if (cost.isLessThan(minCost)) {
            logger.debug(`${market.symbol} adjusted trade cost is below the minimum.`)
            // Add on the minimum amount (this should be a valid precision/step size)
            qty = qty.plus(market.limits.amount.min)
        }
    }

    // Use the ccxt API to ensure the quantity only has the allowed number of decimal places
    return amountToPrecision(market.symbol, qty)
}

// This will update the markets dictionary in the tradingMetaData every 24 hours
// Most of the time you don't need to check the return result, because even if it fails we should have the last set of data
let marketCached = 0
async function refreshMarkets() {
    const elapsed = Date.now() - marketCached
    // Only load if markets haven't been cached yet, or it has been more than 24 hours
    const reload = Object.keys(tradingMetaData.markets).length == 0 || elapsed >= 24 * 60 * 60 * 1000 || elapsed < 0
    
    if (reload) {
        tradingMetaData.markets = await loadMarkets(reload).catch((reason) => {
            logger.silly("refreshMarkets->loadMarkets: " + reason)
            return Promise.reject(reason)
        })

        // Remember last cached time
        marketCached = Date.now()

        // Potentially some symbols may have been withdrawn from Binance, so need to check we don't have any open trades for them
        checkOpenTrades()
    }
}

// This will update the prices dictionary in the tradingMetaData if more than 1 minute since previously loaded
let pricesCached = 0
async function refreshPrices() {
    if (!hasCurrentPrices()) {
        tradingMetaData.prices = await loadPrices().catch((reason) => {
            logger.silly("refreshPrices->loadPrices: " + reason)
            return Promise.reject(reason)
        })

        // Remember last cached time
        pricesCached = Date.now()
    }
}

// Check if the current prices are cached within the past minute
function hasCurrentPrices(): boolean {
    const elapsed = Date.now() - pricesCached
    // Prices are only valid for one minute
    return Object.keys(tradingMetaData.prices).length > 0 && elapsed < 60 * 1000 && elapsed >= 0
}

// Loads the balances from Binance and checks whether you still have sufficient BNB funds to cover fees and interest
// This also helps to pre-cache the balances ready for the next trade
const BNBState: Dictionary<string> = {}
async function checkBNBThreshold(wallet: WalletType) {
    if (env().BNB_FREE_THRESHOLD >= 0) {
        // Initialise dictionary, assuming it is ok to start with
        if (!(wallet in BNBState)) BNBState[wallet] = "ok"

        // Fetch the BNB balance for this wallet and calculate how much is free
        const balance = (await loadWalletBalances(TradingType.real, undefined, "BNB", wallet))[wallet]
        logger.debug(`${balance.free} BNB free in ${wallet}.`)
        if (balance.free.isLessThanOrEqualTo(env().BNB_FREE_THRESHOLD)) {
            // Check if the low balance hasn't already been reported, but report again if it gets below half the threshold
            if (BNBState[wallet] == "ok" || (BNBState[wallet] == "high" && balance.free.isLessThanOrEqualTo(env().BNB_FREE_THRESHOLD / 2)) || (BNBState[wallet] == "low" && balance.free.isLessThanOrEqualTo(0))) {
                // Log the low balance warning or error for empty balance
                let notifyLevel = MessageType.WARN
                let logMessage = `Your ${wallet} wallet only has ${balance.free} BNB free. You may need to top it up.`
                if (balance.free.isLessThanOrEqualTo(0)) {
                    BNBState[wallet] = "empty"
                    notifyLevel = MessageType.ERROR
                    logMessage = `Your ${wallet} wallet has no free BNB. You will need to top it up now.`
                    logger.error(logMessage)
                } else {
                    BNBState[wallet] = balance.free.isLessThanOrEqualTo(env().BNB_FREE_THRESHOLD / 2) ? "low" : "high"
                    logger.warn(logMessage)
                }

                // Send as a notification
                notifyAll({messageType: notifyLevel, subject: notifyLevel, content: logMessage}).catch((reason) => {
                    logger.silly("checkBNBThreshold->notifyAll: " + reason)
                })
            }
        } else {
            // Reset once the balance has exceeded the threshold again
            BNBState[wallet] = "ok"
        }
    }
}

// Calculates how much BNB is needed to restore the float then executes a trade to convert a chosen coin to BNB for that amount
// If successful, the cost of the trade
export async function topUpBNBFloat(wallet: WalletType, quote: string): Promise<string> {
    logger.info(`BNB top up requested on ${wallet}.`)

    const logPrefix = `Cannot top up BNB on ${wallet} because `

    if (env().BNB_FREE_FLOAT <= 0) {
        // This shouldn't happen
        const logMessage = logPrefix + `BNB top up float is disabled.`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }

    if (wallet == WalletType.MARGIN && !env().IS_TRADE_MARGIN_ENABLED) {
        // This shouldn't happen
        const logMessage = logPrefix + `trading is disabled.`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }

    const market = tradingMetaData.markets["BNB" + quote]
    if (!market) {
        const logMessage = logPrefix + `there is no market data for BNB/${quote}.`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }

    if (!market[wallet]) {
        const logMessage = logPrefix + `trading is not allowed for ${market.symbol}.`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }

    // Fetch BNB balances for this wallet and calculate how much is free
    const bnbBalance = (await loadWalletBalances(TradingType.real, undefined, "BNB", wallet))[wallet]

    if (bnbBalance.free.isGreaterThanOrEqualTo(env().BNB_FREE_FLOAT)) {
        const logMessage = logPrefix + `there is already enough free, increase the float if you want to have more.`
        logger.warn(logMessage)
        return Promise.reject(logMessage)
    }

    // Get the latest buy price
    const price = new BigNumber((await fetchTicker(market)).ask)

    if (!price.isGreaterThan(0)) {
        const logMessage = logPrefix + `the current price is invalid.`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }

    // Calculate the legal trade quantity
    const needed = new BigNumber(env().BNB_FREE_FLOAT).minus(bnbBalance.free)
    const qty = getLegalQty(needed, market, price)

    // Due to minimum trade size the legal quanity might be significantly higher than needed
    if (qty.minus(needed).dividedBy(needed).isGreaterThan(2)) {
        const logMessage = logPrefix + `the legal trade cost of ${qty} BNB is much higher than the ${needed} BNB needed to reach the float, increase the float if you want to have more.`
        logger.warn(logMessage)
        return Promise.reject(logMessage)
    }

    // Fetch quote balances for this wallet and calculate how much is free
    const quoteBalance = (await loadWalletBalances(TradingType.real, undefined, quote, wallet))[wallet]

    // Calculate the quote cost
    const cost = qty.multipliedBy(price)

    if (cost.isGreaterThan(quoteBalance.free)) {
        const logMessage = logPrefix + `there needs to be at least ${cost} ${quote} free to complete the trade.`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }

    // Execute the market buy order
    const result = await createMarketOrder(market.symbol, "buy", qty, wallet).catch(reason => {
        const logMessage = logPrefix + `an error occurred: ${reason}`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    })

    if (result.status == "closed") {
        const logMessage = `Successfully bought ${result.amount} BNB for ${result.cost} ${quote} on ${wallet}.`
        logger.info(logMessage)

        // Send an offset fee to the balance history
        // Technically there are also fees for this conversion, but as we're not recording this transaction we'll ignore them
        updateBalanceHistory(TradingType.real, quote, undefined, undefined, new BigNumber(0-result.cost), new BigNumber(result.cost))
        // TODO: if a strategy ever trades in BNB then we may need to update its balances too

        return logMessage
    } else {
        const logMessage = logPrefix + `result status was: ${result.status}`
        logger.error(logMessage)
        return Promise.reject(logMessage)
    }
}

// Main function to start the trader
async function run() {
    logger.info(`NBT Trader v${env().VERSION} is starting...`)

    // Validate environment variable configuration
    let issues: string[] = []
    if (env().MAX_LOG_LENGTH <= 1) issues.push("MAX_LOG_LENGTH must be greater than 0.")
    if (!Number.isInteger(env().MAX_LOG_LENGTH)) issues.push("MAX_LOG_LENGTH must be a whole number.")
    if (env().MAX_DATABASE_ROWS < 100 && env().MAX_DATABASE_ROWS != 0) issues.push("MAX_DATABASE_ROWS must be 0 or 100 or more.")
    if (!Number.isInteger(env().MAX_DATABASE_ROWS)) issues.push("MAX_DATABASE_ROWS must be a whole number.")
    if (env().WALLET_BUFFER < 0 || env().WALLET_BUFFER >= 1) issues.push("WALLET_BUFFER must be from 0 to 0.99.")
    if (env().MAX_SHORT_TRADES < 0) issues.push("MAX_SHORT_TRADES must be 0 or more.")
    if (!Number.isInteger(env().MAX_SHORT_TRADES)) issues.push("MAX_SHORT_TRADES must be a whole number.")
    if (env().MAX_LONG_TRADES < 0) issues.push("MAX_LONG_TRADES must be 0 or more.")
    if (!Number.isInteger(env().MAX_LONG_TRADES)) issues.push("MAX_LONG_TRADES must be a whole number.")
    if (env().STRATEGY_LOSS_LIMIT < 0) issues.push("STRATEGY_LOSS_LIMIT must be 0 or more.")
    if (!Number.isInteger(env().STRATEGY_LOSS_LIMIT)) issues.push("STRATEGY_LOSS_LIMIT must be a whole number.")
    if (env().STRATEGY_LIMIT_THRESHOLD < 0 || env().STRATEGY_LIMIT_THRESHOLD > 1) issues.push("STRATEGY_LIMIT_THRESHOLD must be from 0 to 1.")
    if (env().VIRTUAL_WALLET_FUNDS <= 0) issues.push("VIRTUAL_WALLET_FUNDS must be greater than 0.")
    if (env().BNB_FREE_FLOAT < 0) issues.push("BNB_FREE_FLOAT must be 0 or more.")
    if (env().BNB_FREE_THRESHOLD > 0 && env().BNB_FREE_FLOAT > 0 && env().BNB_FREE_FLOAT <= env().BNB_FREE_THRESHOLD) issues.push("BNB_FREE_FLOAT must be more than BNB_FREE_THRESHOLD.")
    if (env().TAKER_FEE_PERCENT < 0) issues.push("TAKER_FEE_PERCENT must be 0 or more.")
    if (env().MIN_COST_BUFFER < 0) issues.push("MIN_COST_BUFFER must be 0 or more.")
    if (env().IS_FUNDS_NO_LOSS && ![LongFundsType.SELL_ALL, LongFundsType.SELL_LARGEST, LongFundsType.SELL_LARGEST_PNL].includes(env().TRADE_LONG_FUNDS)) issues.push("IS_FUNDS_NO_LOSS should be false if not using one of the 'sell' options for TRADE_LONG_FUNDS.")
    if (!env().IS_TRADE_MARGIN_ENABLED && env().PRIMARY_WALLET == WalletType.MARGIN) issues.push(`PRIMARY_WALLET cannot be ${WalletType.MARGIN} if IS_TRADE_MARGIN_ENABLED is false.`)
    if (!env().IS_TRADE_MARGIN_ENABLED && (env().TRADE_LONG_FUNDS == LongFundsType.BORROW_ALL || env().TRADE_LONG_FUNDS == LongFundsType.BORROW_MIN)) issues.push(`TRADE_LONG_FUNDS cannot be ${env().TRADE_LONG_FUNDS} if IS_TRADE_MARGIN_ENABLED is false.`)
    if (env().IS_NOTIFIER_GMAIL_ENABLED && (!env().NOTIFIER_GMAIL_ADDRESS || !env().NOTIFIER_GMAIL_APP_PASSWORD)) issues.push("NOTIFIER_GMAIL_ADDRESS and NOTIFIER_GMAIL_APP_PASSWORD are required for IS_NOTIFIER_GMAIL_ENABLED.")
    if (env().IS_NOTIFIER_TELEGRAM_ENABLED && (!env().NOTIFIER_TELEGRAM_API_KEY || !env().NOTIFIER_TELEGRAM_RECEIVER_ID)) issues.push("NOTIFIER_TELEGRAM_API_KEY and NOTIFIER_TELEGRAM_RECEIVER_ID are required for IS_NOTIFIER_TELEGRAM_ENABLED.")
    if (issues.length) {
        issues.forEach(issue => logger.error(issue))
        return Promise.reject(issues.join(" "))
    }

    initializeNotifiers()

    // Load data and start connections asynchronously
    startUp().catch((reason) => shutDown(reason))
}

// Loads all the required data and starts connections and web services
async function startUp() {
    if (await initialiseDatabase()) {
        logger.info("Loading previous operating state from the database...")

        // Markets will come from Binance
        // If the process restarts we'll lose the queue, so no need to reload tradesClosing
        // Transactions can be huge, so we save them differently
        // We don't need to keep the public strategies, it is just for info
        const excluded = [ "markets", "prices", "tradesClosing", "transactions", "publicStrategies" ]

        for (const type of Object.keys(tradingMetaData)) {
            if (!excluded.includes(type)) {
                // Try to reload the object from the database, if it fails we don't really care
                const object = await loadObject(type)
                if (object) {
                    Object.assign(tradingMetaData[type as keyof typeof tradingMetaData], object)
                    logger.debug(`Loaded "${type}" successfully.`)
                } else {
                    logger.warn(`Object "${type}" was not previously saved.`)
                }
            }
        }

        // Check to see if data structures have changed
        await upgradeMetaData()
    }
    
    // Make sure the markets data is loaded at least once
    logger.info("Loading Binance market data...")
    await refreshMarkets().catch((reason) => {
        logger.silly("run->refreshMarkets: " + reason)
        return Promise.reject(reason)
    })

    // Note, we can't get previously open trades here because we need to know whether they are real or virtual, so we have to wait for the payload
    // Strategies also come down in the payload, so no signals will be accepted until that is processed

    // Web diagnostics UI and keep alive touch point for uptime bot
    startWebserver()

    // Once it connects to the NBT Hub it should trigger the onUserPayload() method to continue setting up the trader
    socket.connect()

    // Other things will happen after this asynchronously before the trader is operational
    logger.debug("NBT Trader start up sequence is complete.")
}

// Checks the previous version number and applies changes to the tradingMetaData to match current structures
async function upgradeMetaData() {
    let upgrade = false

    // Load the previous version from the database
    let versionStr = await loadObject("Version") as string
    if (!versionStr) versionStr = "1.0.0" // Default version if none previously saved
    // Split the version into parts so that it is easier to check as numbers
    const oldVersion = versionStr.split('.').map(p => Number(p))
    const newVersion = (env().VERSION as string).split('.').map(p => Number(p))

    // Check versions have the same number of parts
    if (oldVersion.length != newVersion.length) {
        // I don't think this will happen
        logger.error(`Unexpected version number: ${versionStr}.`)
        return
    }

    // Check to see if the loaded version number was earlier than the current version
    for (let i=0; i<oldVersion.length; ++i) {
        if (oldVersion[i] < newVersion[i]) {
            upgrade = true
            break
        } else if (oldVersion[i] != newVersion[i]) {
            // I don't think this will happen
            logger.error(`Unexpected version number: ${versionStr}.`)
            return
        }
    }

    if (upgrade) {
        logger.info(`Upgrading meta data from v${versionStr} to v${env().VERSION}...`)

        // Upgrades for version 1.2.0
        if (oldVersion[0] == 1 && oldVersion[1] < 2) {
            // Add estimated fees to balance history
            for (let tradingType of Object.keys(tradingMetaData.balanceHistory)) {
                for (let coin of Object.keys(tradingMetaData.balanceHistory[tradingType])) {
                    tradingMetaData.balanceHistory[tradingType][coin].forEach(h => h.estimatedFees = new BigNumber(0))
                }
            }
            saveState("balanceHistory")
        }

        // TODO: add newer upgrades here so that they can be applied in the correct sequence

        // Save the current version number once all upgrades are complete
        await saveObjects({"Version": env().VERSION})
    }
}

// If something is really broken this will stop the trader
export function shutDown(reason: any) {
    logger.silly("Shutdown: " + reason)
    logger.error("NBT Trader is not operational, shutting down...")
    isOperational = false

    // First try to send a notification that the trader is shutting down
    notifyAll({messageType: MessageType.ERROR, subject: MessageType.ERROR, content: `NBT Trader is not operational, shutting down...\n${reason}`}).catch((reason) => {
        logger.silly("shutDown->notifyAll: " + reason)
    }).finally(() => {
        // Just in case something still needs to be written to the database, try to flush it first
        if (dirty.size) {
            flushDirty().catch(() => {}).finally(process.exit(1))
        } else {
            process.exit(1)
        }
    })
}

// Adds the tradingMetaData object type to the dirty set for saving to the database
function saveState(type: keyof typeof tradingMetaData) {
    // Save state may be called many times in the same thread
    dirty.add(type)
    // Calling this asynchronously will ensure that it only gets updated once the thread is free
    flushDirty().catch((reason) => shutDown(reason))
}

// Processes the dirty meta data requests and writes them to the database
async function flushDirty() {
    // Wait 100 milliseconds to allow other execution to complete in case there are more objects that need to be saved
    if (dirty.size) await new Promise( resolve => setTimeout(resolve, 100) )
    // Double check that another flush didn't get here first
    if (dirty.size) {
        logger.debug(`Flushing ${dirty.size} dirty objects: ${Array.from(dirty).join(", ")}.`)
        const objects: Dictionary<any> = {}
        dirty.forEach(type => objects[type] = tradingMetaData[type as keyof typeof tradingMetaData])
        dirty.clear()
        await saveObjects(objects)
    }
}

// WARNING: Only use this function on the testnet API if you need to reset balances, it is super dangerous
async function sellEverything(base: string, fraction: number) {
    const balances = await fetchBalance(WalletType.SPOT)
    for (let quote of Object.keys(balances)) {
        const market = tradingMetaData.markets[quote + base]
        if (market && balances[quote].free) {
            const qty = balances[quote].free * fraction
            logger.debug(`Selling ${qty} ${quote}.`)
            logger.debug(await createMarketOrder(quote + "/" + base, "sell", new BigNumber(qty), WalletType.SPOT).then(order => `${order.status} ${order.cost}`).catch(e => e.name))
        }
    }
    await fetchBalance(WalletType.SPOT)
}

// Starts the trader
if (process.env.NODE_ENV !== "test") {
    run().catch((reason) => shutDown(reason))
}

const exportFunctions = {
    trade,
}

export default exportFunctions