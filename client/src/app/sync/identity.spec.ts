import { createIdentity, identityFromNodeId, PEER_INKS } from './identity';

describe('identityFromNodeId', () => {
  it('gives the same name and color for the same id, and one of the known inks', () => {
    const a = identityFromNodeId('0a1b2c3d4e5f6071');
    const b = identityFromNodeId('0a1b2c3d4e5f6071');
    expect(a).toEqual(b);
    expect(PEER_INKS).toContain(a.color);
  });

  it('reads the first byte for the name and the second for the ink', () => {
    // Bytes 0x00 and 0x0c both pick the first of 12 names; bytes 0x00 and 0x07 both pick the first of 7 inks.
    expect(identityFromNodeId('0001').name).toBe(identityFromNodeId('0c01').name);
    expect(identityFromNodeId('0000').color).toBe(identityFromNodeId('0007').color);
    expect(identityFromNodeId('0001').name).not.toBe(identityFromNodeId('0101').name);
    expect(identityFromNodeId('0000').color).not.toBe(identityFromNodeId('0001').color);
  });

  it('copes with an id that is not hex', () => {
    const who = identityFromNodeId('node-a');
    expect(who.name).toBeTruthy();
    expect(PEER_INKS).toContain(who.color);
  });

  it('is what createIdentity uses, so a tab and its history entries agree', () => {
    const me = createIdentity();
    expect(identityFromNodeId(me.nodeId)).toEqual(me);
  });
});
