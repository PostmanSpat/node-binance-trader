// Return type for getting current margin loans
export interface Loan {
    borrowed: number
    interest: number
}

// Return type for borrow and repay margin loans
export interface LoanTransaction {
    tranId: number
}

// Return type for current ticker price
export interface Price {
    symbol: string
    price: string
}

// Return type for querying margin pairs
export interface MarginInfo {
    base: string
    id: number
    isBuyAllowed: boolean
    isMarginTrade: boolean
    isSellAllowed: boolean
    quote: string
    symbol: string
}