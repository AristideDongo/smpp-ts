import { SmppStateError } from '../errors.js';
import { type CommandName, isResponseCommand } from '../protocol/commands.js';

/** États de session (REL-01). */
export type SessionState = 'CLOSED' | 'OPEN' | 'BOUND_TX' | 'BOUND_RX' | 'BOUND_TRX' | 'UNBOUND';

/** `esme` : client (application). `smsc` : serveur (centre de messages). */
export type SessionRole = 'esme' | 'smsc';

export type BindMode = 'transmitter' | 'receiver' | 'transceiver';

const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  CLOSED: ['OPEN'],
  OPEN: ['BOUND_TX', 'BOUND_RX', 'BOUND_TRX', 'UNBOUND', 'CLOSED'],
  BOUND_TX: ['UNBOUND', 'CLOSED'],
  BOUND_RX: ['UNBOUND', 'CLOSED'],
  BOUND_TRX: ['UNBOUND', 'CLOSED'],
  UNBOUND: ['CLOSED'],
};

export const BIND_COMMANDS: Record<BindMode, 'bind_transmitter' | 'bind_receiver' | 'bind_transceiver'> = {
  transmitter: 'bind_transmitter',
  receiver: 'bind_receiver',
  transceiver: 'bind_transceiver',
};

export const BOUND_STATE: Record<BindMode, SessionState> = {
  transmitter: 'BOUND_TX',
  receiver: 'BOUND_RX',
  transceiver: 'BOUND_TRX',
};

export function bindModeOf(command: CommandName): BindMode | undefined {
  switch (command) {
    case 'bind_transmitter':
      return 'transmitter';
    case 'bind_receiver':
      return 'receiver';
    case 'bind_transceiver':
      return 'transceiver';
    default:
      return undefined;
  }
}

export function isBound(state: SessionState): boolean {
  return state === 'BOUND_TX' || state === 'BOUND_RX' || state === 'BOUND_TRX';
}

const canTransmit = (s: SessionState) => s === 'BOUND_TX' || s === 'BOUND_TRX';
const canReceiveMessages = (s: SessionState) => s === 'BOUND_RX' || s === 'BOUND_TRX';

/** Opérations de soumission : ESME → SMSC, session transmitter ou transceiver. */
const SUBMISSION = new Set<CommandName>([
  'submit_sm',
  'submit_multi',
  'query_sm',
  'cancel_sm',
  'replace_sm',
  'broadcast_sm',
  'query_broadcast_sm',
  'cancel_broadcast_sm',
]);

/** Opérations de remise : SMSC → ESME, session receiver ou transceiver. */
const DELIVERY = new Set<CommandName>(['deliver_sm', 'alert_notification']);

/**
 * Vrai si `sender` peut émettre `command` dans l'état `state` (REL-01, SEC-06, SEC-07).
 * Sert aux deux sens : `canReceive(role) = canSend(rôle du pair)`.
 */
export function canSend(sender: SessionRole, state: SessionState, command: CommandName): boolean {
  if (state === 'CLOSED') return false;
  if (isResponseCommand(command)) return true;
  if (command === 'enquire_link') return state !== 'UNBOUND';
  if (bindModeOf(command)) return sender === 'esme' && state === 'OPEN';
  if (command === 'outbind') return sender === 'smsc' && state === 'OPEN';
  if (command === 'unbind') return isBound(state);
  if (SUBMISSION.has(command)) return sender === 'esme' && canTransmit(state);
  if (DELIVERY.has(command)) return sender === 'smsc' && canReceiveMessages(state);
  if (command === 'data_sm') return sender === 'esme' ? canTransmit(state) : canReceiveMessages(state);
  return false;
}

export function peerRole(role: SessionRole): SessionRole {
  return role === 'esme' ? 'smsc' : 'esme';
}

/** Commandes autorisées pour un mode de bind (contrôle local avant envoi, SEC-07). */
export function canSendInMode(sender: SessionRole, mode: BindMode, command: CommandName): boolean {
  if (bindModeOf(command) || command === 'outbind') return false;
  return canSend(sender, BOUND_STATE[mode], command);
}

/** Machine à états : chaque transition est validée et notifiée. */
export class StateMachine {
  private current: SessionState;

  constructor(
    initial: SessionState,
    private readonly onChange: (from: SessionState, to: SessionState) => void,
  ) {
    this.current = initial;
  }

  get state(): SessionState {
    return this.current;
  }

  canTransition(to: SessionState): boolean {
    return TRANSITIONS[this.current].includes(to);
  }

  transition(to: SessionState): void {
    if (to === this.current) return;
    if (!this.canTransition(to)) {
      throw new SmppStateError(`transition to ${to}`, this.current);
    }
    const from = this.current;
    this.current = to;
    this.onChange(from, to);
  }
}
