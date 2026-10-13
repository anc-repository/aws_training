/** RunCommandPort for the lifecycle tests: ATL-WorkstationSetup succeeds unless a failure is queued. */
import { PortError, type CommandInvocation, type RunCommandPort, type SendCommandRequest } from '@atl/shared';

export class FakeRunCommand implements RunCommandPort {
  readonly sent: SendCommandRequest[] = [];
  private readonly invocations = new Map<string, CommandInvocation>();
  /** statuses for the next commands (FIFO), default Success */
  readonly next: CommandInvocation['status'][] = [];
  private seq = 0;

  async sendCommand(req: SendCommandRequest): Promise<{ commandId: string }> {
    this.sent.push(req);
    const commandId = `cmd-${++this.seq}`;
    const status = this.next.shift() ?? 'Success';
    for (const id of req.instanceIds) {
      this.invocations.set(`${commandId}/${id}`, { commandId, instanceId: id, status, responseCode: status === 'Success' ? 0 : 1, stdout: '', stderr: status === 'Success' ? '' : 'setup failed (test)' });
    }
    return { commandId };
  }

  async getInvocation(commandId: string, instanceId: string): Promise<CommandInvocation> {
    const inv = this.invocations.get(`${commandId}/${instanceId}`);
    if (!inv) throw new PortError('NotFound', 'InvocationDoesNotExist');
    return { ...inv };
  }
}
