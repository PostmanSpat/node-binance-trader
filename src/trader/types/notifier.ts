export interface Notifier {
    notify: (notifierMessage: NotifierMessage) => Promise<void>
}

export interface NotifierMessage {
    messageType: MessageType
    subject?: string
    content: string
    contentHtml?: string
}

// Represents the different types of notification messages that can be sent
export enum MessageType {
    INFO = "",
    SUCCESS = "SUCCESS!",
    ERROR = "ERROR!",
    WARN = "WARNING!"
}