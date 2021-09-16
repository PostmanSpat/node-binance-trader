import BigNumber from "bignumber.js"

export enum Pages {
    TRADES = "Open<br />Trades",
    STRATEGIES = "Strategies",
    VIRTUAL = "Virtual<br />Balances",
    LOG_MEMORY = "Log<br />(Since Restart)",
    LOG_DB = "Log<br />(History)",
    TRANS_MEMORY = "Transactions<br />(Since Restart)",
    TRANS_DB = "Transactions<br />(History)",
    PNL = "Profit n Loss /<br />Balance History"
}

export const URLs = {
    [Pages.TRADES]: "trades?",
    [Pages.STRATEGIES]: "strategies?",
    [Pages.VIRTUAL]: "virtual?",
    [Pages.LOG_MEMORY]: "log?",
    [Pages.LOG_DB]: "log?db=%d&", // Page number will be inserted as needed
    [Pages.TRANS_MEMORY]: "trans?",
    [Pages.TRANS_DB]: "trans?db=%d&", // Page number will be inserted as needed
    [Pages.PNL]: "pnl?",
}

export class Percent {
    value: BigNumber
    precision: number

    constructor(value: BigNumber, precision: number = 2) {
        this.value = value
        this.precision = precision
    }

    public toString = () : string => {
        return this.value.toFixed(this.precision) + "%"
    }
}

// Represents the statistics for a single time step and transaction type
export class TransactionSummary {
    opened: number = 0 // Number of trades opened
    closed: number = 0 // Number of trades closed
    buy: number = 0 // Quantity of asset used to buy
    sell: number = 0 // Quantity of asset used to sell
    profitLoss: number = 0 // Total profit or loss
}