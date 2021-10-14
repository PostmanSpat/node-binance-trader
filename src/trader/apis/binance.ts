import ccxt, { Dictionary } from "ccxt"

import env from "../env"
import logger from "../../logger"
import BigNumber from "bignumber.js"
import { WalletType } from "../types/trader"
import { Loan, LoanTransaction, MarginInfo, Price } from "../types/binance"

const logBinanceUndefined = "Binance client is undefined!"

let binanceClient: ccxt.binance
const sandbox = process.env.NODE_ENV === "staging"

// Used to track when the last buy / sell / borrow / repay occurred to allow for balance sync
// This should always be updated before and after the transaction is executed on Binance
const lastChangeTimes: Dictionary<Number> = {}

// Cached balances for better performance, especially for the fall back wallet that is not used often
const balances: Dictionary<ccxt.Balances> = {}
const balanceTimestamps: Dictionary<Number> = {}

if (process.env.NODE_ENV !== "test") {
    binanceClient = new ccxt.binance({
        apiKey: env().BINANCE_API_KEY,
        enableRateLimit: true,
        secret: env().BINANCE_SECRET_KEY,
    })

    if (sandbox) {
        binanceClient.setSandboxMode(true)
    }
}

// Gets all of the supported coin pairs (symbols) and associated flags and limits
export async function loadMarkets(isReload?: boolean): Promise<ccxt.Dictionary<ccxt.Market>> {
    if (!binanceClient) return Promise.reject(logBinanceUndefined)
    
    // The margin flag in loadMarkets covers both cross and isolated, but we only care about cross
    const crossMarginPairs: Dictionary<MarginInfo> = sandbox ? {} : await binanceClient.sapiGetMarginAllPairs()
    .then((value: MarginInfo[]) => {
        if (logger.isSillyEnabled()) logger.silly(`Loaded cross margin pairs: ${JSON.stringify(value)}`)

        // Convert to dictionary for easier processing
        const results: Dictionary<MarginInfo> = {}
        value.forEach(info => {
            results[info.symbol] = info
        })
        logger.debug(`Loaded ${Object.keys(results).length} margin pairs.`)
        return results
    })
    .catch((reason: any) => {
        logger.error(`Failed to get cross margin pairs: ${reason}`)
        return Promise.reject(reason)
    })

    return binanceClient.loadMarkets(isReload)
        .then((value) => {
            if (logger.isSillyEnabled()) logger.silly(`Loaded markets: ${JSON.stringify(value)}`)
            const markets: Dictionary<ccxt.Market> = JSON.parse(JSON.stringify(value)) // Clone object
            Object.keys(markets).forEach((key) => {
                // Work around the missing slash ("/") in BVA's signal data
                const market = markets[key]
                const keyNew = market.id
                markets[keyNew] = market

                // Work around for combined cross and isolated margin flag from Binance
                if (crossMarginPairs[keyNew]) {
                    market.margin = crossMarginPairs[keyNew].isMarginTrade
                } else {
                    market.margin = false
                }

                delete markets[key]
            })
            logger.debug(`Loaded ${Object.keys(markets).length} markets.`)
            return markets
        })
        .catch((reason) => {
            logger.error(`Failed to get markets: ${reason}`)
            return Promise.reject(reason)
        })
}

// Loads the latest prices for all symbols
export async function loadPrices(): Promise<Dictionary<BigNumber>> {
    // Uses the Binance specific call for prices because the data packet is much smaller than the standard .fetchTickers() ccxt call
    return await binanceClient.publicGetTickerPrice().then((value: Price[]) => {
        const prices: Dictionary<BigNumber> = {}
        
        if (logger.isSillyEnabled()) logger.silly(`Loaded prices: ${JSON.stringify(value)}`)
        // No need to clear the previous prices, if something has been deleted since last update then we don't really care
        value.forEach((price) => {
            // Convert prices array to dictionary for faster indexing
            prices[price.symbol] = new BigNumber(price.price)
        })
        logger.debug(`Loaded ${value.length} prices.`)
        return prices
    })
    .catch((reason: any) => {
        logger.error(`Failed to get prices: ${reason}`)
        return Promise.reject(reason)
    })
}

// Get the current market bid and ask prices information for a given symbol
export async function fetchTicker(market: ccxt.Market): Promise<ccxt.Ticker> {
    if (!binanceClient) return Promise.reject(logBinanceUndefined)

    return binanceClient.fetchTicker(market.symbol)
        .then((value) => {
            if (logger.isSillyEnabled()) logger.silly(`Loaded ticker: ${JSON.stringify(value)}`)
            logger.debug(`Loaded ${value.symbol} ticker, buy price is ${value.bid}, sell price is ${value.ask}.`)
            return value
        })
        .catch((reason) => {
            logger.error(`Failed to get ticker: ${reason}`)
            return Promise.reject(reason)
        })
}

// Gets the current balances for a given wallet type 'margin' or 'spot'
export async function fetchBalance(type: WalletType): Promise<ccxt.Balances> {
    if (!binanceClient) return Promise.reject(logBinanceUndefined)

    // Hack, as you can't look up margin balances on testnet (NotSupported error), but this is only for testing
    if (sandbox) type = WalletType.SPOT

    // If a wallet has been touched then it will already be cleared from the cache
    if (balances.hasOwnProperty(type)) {
        // Check that the cached balances are less than 24 hours old
        const elapsed = Date.now() - (balanceTimestamps[type] as number)
        if (elapsed >=0 && elapsed < 24 * 60 * 60 * 1000) {
            // Use the cache
            logger.debug(`Using cached ${type} balances.`)
            return balances[type]
        } else {
            // Clear the old cached balances so that it doesn't get used below
            delete balances[type]
            delete balanceTimestamps[type]
        }
    }

    // According to Binance support it can take from 1 to 10 seconds for the balances to sync after making a trade
    // Therefore if there are a lot of signals happening at the same time it can give the wrong results, so we're just going to slow it down a bit
    // The recommended subscribing to the web socket for user updates, but that would be more work, and hopefully this won't happen too often
    // Just in case another trade happens while waiting, check again after waiting
    while (timeSinceLastChange(type) < env().BALANCE_SYNC_DELAY) {
        // Add an extra 10ms just so we don't go around again
        const delay = (env().BALANCE_SYNC_DELAY - timeSinceLastChange(type)) + 10

        logger.debug(`Waiting ${delay} milliseconds to allow balances to synchronise.`)

        await new Promise( resolve => setTimeout(resolve, delay) )
    }

    // Other requests may have fetched the balances while we were waiting, so check the cache again
    if (balances.hasOwnProperty(type)) {
        logger.debug(`Using newly cached ${type} balances.`)
        return balances[type]
    }

    return binanceClient.fetchBalance({type: type})
        .then((value) => {
            if (logger.isSillyEnabled()) logger.silly(`Fetched balance: ${JSON.stringify(value)}`)
            logger.debug(`Loaded ${Object.keys(value).length} ${type} balances.`)

            // Cache for next time
            balances[type] = value
            balanceTimestamps[type] = Date.now()
            
            return value
        })
        .catch((reason) => {
            logger.error(`Failed to get ${type} balance: ${reason}`)
            return Promise.reject(reason)
        })
}

// Takes the output from fetchBalance(MARGIN) and extracts the borrowed and interest values for each asset
export function getMarginLoans(marginBalance: ccxt.Balances): Dictionary<Loan> {
    if (sandbox) {
        // Hack, as you can't look up margin balances on testnet (NotSupported error), but this is only for testing
        const fake: Dictionary<Loan> = {}
        for (let asset of Object.keys(marginBalance)) {
            if (marginBalance[asset] instanceof Object && 'free' in marginBalance[asset]) {
                fake[asset] = {
                    borrowed: 0.0,
                    interest: 0.0
                }
            }
        }
        return fake
    } else {
        if (!('userAssets' in marginBalance.info)) {
            logger.error("Invalid margin balances, cannot extract loans.")
            return {}
        }

        // Extract the loans from the secret property, and remap to a dictionary of assets
        return marginBalance.info.userAssets.reduce((output: Dictionary<Loan>, asset: {asset: string, borrowed: string, interest: string}) => {
            output[asset.asset] = { // Use asset as the key
                borrowed: parseFloat(asset.borrowed),
                interest: parseFloat(asset.interest)
            }
            return output
        }, {})
    }
}

// Calculate how much time has elapsed since the balances were changed in Binance for the specified wallet
function timeSinceLastChange(type: WalletType): number {
    const now = Date.now()

    // Initialise
    if (!lastChangeTimes.hasOwnProperty(type)) lastChangeTimes[type] = 0

    // Maybe a time update, so we can't trust it anymore
    if (now < lastChangeTimes[type]) lastChangeTimes[type] = 0

    return now - (lastChangeTimes[type] as number)
}

// Update the time of last change and reset the balances for a specified wallet
function balanceChanged(type: WalletType) {
    lastChangeTimes[type] = Date.now()

    if (balances.hasOwnProperty(type)) {
        delete balances[type]
        delete balanceTimestamps[type]
    }
}

// Places a market order for a symbol pair on the specified wallet
export async function createMarketOrder(
    symbol: string,
    side: "buy" | "sell",
    amount: BigNumber,
    walletType: WalletType,
    price?: BigNumber
): Promise<ccxt.Order> {
    if (!binanceClient) return Promise.reject(logBinanceUndefined)
    balanceChanged(walletType)
    return binanceClient.createMarketOrder(
        symbol,
        side,
        amount.toNumber(),
        price?.toNumber(),
        {
            type: walletType
        }
    ).then((result) => {
        balanceChanged(walletType)
        return result
    })
}

// Borrows an asset on the cross margin wallet
export async function marginBorrow(
    asset: string,
    amount: BigNumber
): Promise<LoanTransaction> {
    if (!binanceClient) return Promise.reject(logBinanceUndefined)
    balanceChanged(WalletType.MARGIN)
    return binanceClient.sapiPostMarginLoan({
        asset,
        //isIsolated: 'FALSE', // "FALSE" for cross margin borrow without specification of a symbol.
        amount: amount.toFixed()
    }).then((result: LoanTransaction) => {
        balanceChanged(WalletType.MARGIN)
        return result
    })
}

// Repays an asset on the cross margin wallet
export async function marginRepay(
    asset: string,
    amount: BigNumber
): Promise<LoanTransaction> {
    if (!binanceClient) return Promise.reject(logBinanceUndefined)
    balanceChanged(WalletType.MARGIN)
    return binanceClient.sapiPostMarginRepay({
        asset,
        //isIsolated: 'FALSE', // "FALSE" for cross margin repay without specification of a symbol.
        amount: amount.toFixed()
    }).then((result: LoanTransaction) => {
        balanceChanged(WalletType.MARGIN)
        return result
    })
}

// Applies precition / step size to the order quantity, also checks lot size
export function amountToPrecision(symbol: string, quantity: BigNumber): BigNumber {
    return new BigNumber(binanceClient.amountToPrecision(symbol, quantity.toNumber()))
}