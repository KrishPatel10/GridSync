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

/**
 * The name and ink a node id stands for. They come from its first two bytes, so they are a pure
 * function of the id: anyone who only has the id (an edit in the history view, long after its author
 * left) shows the same name and color the author had. An id that is not hex digits (not made here)
 * falls back to the first name and ink.
 */
export function identityFromNodeId(nodeId: string): Identity {
  const byte = (at: number): number => {
    const value = parseInt(nodeId.substring(at * 2, at * 2 + 2), 16);
    return Number.isNaN(value) ? 0 : value;
  };
  return { nodeId, name: pick(NAMES, byte(0)), color: pick(PEER_INKS, byte(1)) };
}

export function createIdentity(): Identity {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return identityFromNodeId(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
}
