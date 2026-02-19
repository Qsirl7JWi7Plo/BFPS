/**
 * Command — abstract base class for the Command pattern.
 * Every concrete command overrides execute() and optionally undo().
 */
export class Command {
  /**
   * Execute this command.
   * @abstract
   */
  execute() {
    throw new Error('Command.execute() must be overridden');
  }

  /**
   * Reverse the effect of this command (optional).
   */
  undo() {
    /* no-op by default */
  }
}
