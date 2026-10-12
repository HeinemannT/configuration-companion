import { describe, expect, it } from 'vitest';
import { accessDestinationForObject, parseAccessDestination, policyDestination } from './entry';

describe('Access destinations', () => {
  it('keeps native RIDs as strings and preserves the zero-based trace statement', () => {
    expect(policyDestination({ policyRid: '9000000000000000001', statementIndex: '0' }))
      .toEqual({ kind: 'policy', rid: '9000000000000000001', statement: 0 });
    expect(parseAccessDestination({ kind: 'role', rid: Number('9000000000000000001') })).toBeUndefined();
    expect(policyDestination({ policyRid: '" onclick="', statementIndex: '1' })).toBeUndefined();
    expect(policyDestination({ policyRid: '123', statementIndex: '-1' })).toEqual({ kind: 'policy', rid: '123' });
  });
  it('routes configuration references to their editor and business objects to a prefilled test', () => {
    expect(accessDestinationForObject({ rid: '1', type: 'Role' })).toEqual({ kind: 'role', rid: '1' });
    expect(accessDestinationForObject({ rid: '2', type: 'AccessPolicy' })).toEqual({ kind: 'policy', rid: '2' });
    expect(accessDestinationForObject({ rid: '3', type: 'Organisation', businessId: 'IFX', name: 'Organization' }))
      .toEqual({ kind: 'test', object: { rid: '3', type: 'Organisation', id: 'IFX', name: 'Organization' } });
  });
});
