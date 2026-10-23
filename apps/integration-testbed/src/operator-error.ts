/** A problem the operator fixes in their environment or on chain; its message is the whole report,
 *  so the top level prints it without a stack. */
export class OperatorError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "OperatorError"
    }
}
