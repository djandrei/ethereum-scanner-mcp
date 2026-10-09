import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseQuery, hexaizeQuery, createMatcher, QueryError } from '../src/query.js';
import { template } from './stub-provider.js';

test('hexaizes the README examples exactly as the CLI does', () =>
{
    assert.equal(hexaizeQuery('<<transfer(address,uint256)>>').hexaizedQuery, '<a9059cbb>');
    assert.equal(hexaizeQuery('<<0x21[0-9]{4}3131>>').hexaizedQuery, '<21[0-9]{4}3131>');
    assert.equal(
        hexaizeQuery('<<transfer(address,uint256)>> && ! <<0x21[0-9]{4}3131>>').hexaizedQuery,
        '<a9059cbb> && ! <21[0-9]{4}3131>');
    assert.equal(
        hexaizeQuery('( <<kill(address)>> || <<selfdestruct(address)>> ) && <<withdraw(address,uint256)>>').tokens.length,
        3);
});

test('reports token kinds and selectors', () =>
{
    const { tokens } = hexaizeQuery('<<transfer(address,uint256)>> || <<0xDEAD>>');
    assert.deepEqual(tokens, [
        { raw: 'transfer(address,uint256)', kind: 'signature', hex: 'a9059cbb' },
        { raw: '0xDEAD', kind: 'hex', hex: 'dead' }
    ]);
});

test('accepts tuple and array types in signatures', () =>
{
    assert.equal(parseQuery('<<f((uint256,address)[],bytes32)>>').length, 1);
});

const rejected = [
    ['', 'empty'],
    ['transfer(address,uint256)', 'bare signature outside a token'],
    ['<<transfer(address,uint256)>> && 1', 'bare number'],
    ['<<transfer(address,uint256)>> && import("x")', 'function call'],
    ['<<transfer(address,uint256)>', 'unterminated token'],
    ['<<>>', 'empty token'],
    ['<<0x>>', 'empty hex pattern'],
    ['<<0x12$>>', 'disallowed metacharacter'],
    ['<<0x(ab+)+>>', 'nested quantifier'],
    ['<<0x[ab>>', 'invalid regex'],
    ['! ( <<a()>> )', 'negated group'],
    ['<<a()>> <<b()>>', 'missing operator'],
    ['<<a()>> &&', 'trailing operator'],
    ['(<<a()>>', 'unbalanced parenthesis'],
    ['<<a()>> & <<b()>>', 'single ampersand'],
    ['<'.repeat(1) + '<a()>'.repeat(1) + '>' + 'x'.repeat(2048), 'over-length']
];

for (const [query, why] of rejected)
{
    test(`rejects ${why}`, () =>
    {
        assert.throws(() => parseQuery(query), QueryError);
    });
}

test('rejects more than 32 tokens', () =>
{
    const query = Array(33).fill('<<a()>>').join(' || ');
    assert.throws(() => parseQuery(query), /exceeds 32 tokens/);
});

test('matches the template bytecode like the scanner', () =>
{
    const code = template[0].contractBytecode;
    assert.equal(createMatcher('<<0x549262ba>>').matches(code), true);
    assert.equal(createMatcher('<<transfer(address,uint256)>>').matches(code), false);
    assert.equal(createMatcher('<<0x549262ba>> && ! <<transfer(address,uint256)>>').matches(code), true);
    assert.equal(createMatcher('<<0x549262ba>> && <<transfer(address,uint256)>>').matches(code), false);
    assert.equal(createMatcher('<<0x6d4ce63c14[0-9a-f]{4}>>').matches(code), true);
    assert.equal(createMatcher('<<0x549262ba>>').matches('0x'), false);
    assert.equal(createMatcher('<<0x549262ba>>').matches(''), false);
});
