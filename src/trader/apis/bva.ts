import axios from "axios"

import env from "../env"
import logger from "../../logger"
import { BvaCommand, TradeOpen, TradeOpenJson } from "../types/bva"

// Gets a list of all open trades for the user
export async function getTradeOpenList(): Promise<TradeOpen[]> {
    return new Promise((resolve, reject) => {
        axios
            .get(
                `https://bitcoinvsaltcoins.com/api/useropentradedsignals?key=${
                    env().BVA_API_KEY
                }`
            )
            .then((response) => {
                if (logger.isSillyEnabled()) logger.silly(`Fetched trades: ${JSON.stringify(response.data)}`)
                const bvaCommand: BvaCommand = response.data
                const tradeOpens = bvaCommand.rows.map(
                    (tradeOpenJson) => new TradeOpen(tradeOpenJson)
                )

                const tradeOpenSymbols = tradeOpens
                    .map((tradeOpen) => tradeOpen.symbol)
                    .join(", ")
                logger.info(
                    `Fetched ${tradeOpens.length} open trades${
                        tradeOpenSymbols && ": " + tradeOpenSymbols
                    }.`
                )

                resolve(tradeOpens)
            })
            .catch((reason) => {
                logger.error(`Failed to get open trades: ${reason}`)
                reject(reason)
            })
    })
}

// Gets a list of all open trades for the source strategy
export async function getStratTradeOpenList(stratid: string): Promise<TradeOpen[]> {
    return new Promise((resolve, reject) => {
        axios
            .get(
                `https://api-bva.herokuapp.com/api/opensignals?id=${stratid}`
            )
            .then((response) => {
                if (logger.isSillyEnabled()) logger.silly(`Fetched strategy trades: ${JSON.stringify(response.data)}`)
                const data: TradeOpenJson[] = response.data
                const tradeOpens = data.map(
                    (tradeOpenJson) => new TradeOpen(tradeOpenJson)
                )

                const tradeOpenSymbols = tradeOpens
                    .map((tradeOpen) => tradeOpen.symbol)
                    .join(", ")
                logger.debug(
                    `Fetched ${tradeOpens.length} open trades for ${stratid}${
                        tradeOpenSymbols && ": " + tradeOpenSymbols
                    }.`
                )

                resolve(tradeOpens)
            })
            .catch((reason) => {
                logger.error(`Failed to get strategy open trades: ${reason}`)
                reject(reason)
            })
    })
}