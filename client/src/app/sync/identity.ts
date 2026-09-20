/** Who this browser tab is, for presence and for stamping edits. A fresh identity per tab. */
export interface Identity {
  readonly nodeId: string;
  readonly name: string;
  readonly color: string;
}

const NAMES = ['Otter', 'Heron', 'Lynx', 'Marten', 'Wren', 'Ibex', 'Puffin', 'Gecko', 'Kestrel', 'Tapir', 'Newt', 'Bison'];

/**
 * Colored-pencil inks for other people's cursors. Blueprint blue is left out on purpose:
 * it's reserved for your own selection, so you can always tell yourself apart.
 */
export const PEER_INKS = ['#C2255C', '#D9480F', '#2F9E44', '#6741D9', '#0C8599', '#A61E4D', '#8F5B00'];

function pick<T>(items: readonly T[], random: number): T {
  return items[random % items.length];
}

export function createIdentity(): Identity {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const nodeId = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return {
    nodeId,
    name: pick(NAMES, bytes[0]),
    color: pick(PEER_INKS, bytes[1]),
  };
}
