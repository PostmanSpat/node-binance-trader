import BigNumber from "bignumber.js"
import { basename } from "path/posix"
import logger from "../../logger"
import { EntryType, PositionType, Signal, TradeOpen } from "../types/bva"
import { MessageType, Notifier, NotifierMessage } from "../types/notifier"
import { SourceType } from "../types/trader"
import env from "./../env"
import gmail from "./gmail"
import telegram from "./telegram"

const notifiers: Notifier[] = []

export default function initializeNotifiers(): Notifier {
    if (env().IS_NOTIFIER_GMAIL_ENABLED) notifiers.push(gmail())
    if (env().IS_NOTIFIER_TELEGRAM_ENABLED) notifiers.push(telegram())

    return {
        notify: notifyAll,
    }
}

// Sends notifications on all the different channels
export function notifyAll(notifierMessage: NotifierMessage): Promise<void> {
    const valLevels = Object.values(MessageType)
    const keyLevels = Object.keys(MessageType)
    if (valLevels.indexOf(notifierMessage.messageType) < keyLevels.indexOf((env().NOTIFIER_LEVEL as string).toUpperCase())) {
        // The level of this message is too low to send, so just return
        return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
        Promise.all(
            notifiers.map((notifier) => notifier.notify(notifierMessage))
        ).then(() => resolve())
        .catch(reason => {
            logger.error(reason)
            reject(reason)
        })
    })
}

export function getNotifierMessage(
    messageType: MessageType,
    source?: SourceType,
    signal?: Signal,
    tradeOpen?: TradeOpen,
    reason?: string
): NotifierMessage {
    const type = tradeOpen ? "trade" : signal ? "signal" : "Notification"
    const action = signal
        ? `${signal.entryType as EntryType} ${signal.symbol} ${signal.positionType} ${type}.`
        : tradeOpen
        ? `${tradeOpen.symbol} ${tradeOpen.positionType} ${type}.`
        : type

    const base = `${messageType} ${action}`.trim()
    const colour = messageType == MessageType.SUCCESS ? "#008000" : "#ff0000"
    const baseHtml = messageType == MessageType.INFO 
        ? `<b>${action}</b>`
        : `<font color=${colour}><b>${messageType}</b></font> ${action}`
    
    const content: string[] = [""]

    if (source) {
        content.push("source: " + source)
    }

    if (signal) {
        content.push("strategy: " + signal.strategyName)
        content.push("signal price: " + format(signal.price))
        content.push("score: ") + signal.score === "NA" ? "N/A" : signal.score
        content.push("signal received: " + format(signal.timestamp))
    } else if (tradeOpen) {
        // This should only happen when we are re-balancing a LONG trade
        content.push("strategy: " + tradeOpen.strategyName)
    }

    if (tradeOpen) {
        content.push("quantity: " + format(tradeOpen.quantity))
        content.push("cost: " + format(tradeOpen.cost))
        content.push("borrow: " + format(tradeOpen.borrow))
        content.push("wallet: " + format(tradeOpen.wallet))
        content.push("type: " + format(tradeOpen.tradingType))

        content.push("trade buy price: " + format(tradeOpen.priceBuy))
        content.push("buy executed: " + format(tradeOpen.timeBuy))
        content.push("trade sell price: " + format(tradeOpen.priceSell))
        content.push("sell executed: " + format(tradeOpen.timeSell))
    }

    if (reason) {
        content.push("")
        content.push(reason)
    }

    return {
        messageType: messageType,
        subject: base,
        content: base + content.join("\n"),
        contentHtml: baseHtml + content.join("<br/>"),
    }
}

function format(value: BigNumber | Date | String | undefined): String {
    if (value == undefined) return ""

    if (value instanceof BigNumber) {
        return value.toFixed(env().MAX_WEB_PRECISION).replace(/\.?0+$/,"")
    }

    if (value instanceof Date) {
        return value.toISOString()
    }

    if (value instanceof String) {
        return value
    }

    return String(value)
}