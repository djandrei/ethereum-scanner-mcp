/**
 * Query validation and matching.
 *
 * The scanner's SearchUtils hands everything outside a `< >` token to
 * mathjs eval(). The CLI trusts its operator; this server does not trust
 * the model, so a strict grammar is enforced before a query reaches
 * SearchUtils:
 *
 *   query := term ( ('&&' | '||') term )*
 *   term  := '!'? token | '(' query ')'
 *   token := '<<' body '>>'
 *   body  := signature | hexpattern
 *
 * `!` is only accepted directly before a token because SearchUtils only
 * resolves `! <token>`; `! ( ... )` would reach mathjs as a factorial.
 */

import { createRequire } from 'node:module';

/** The parts of the scanner's SearchUtils (CommonJS, untyped) that this server uses. */
interface SearchUtilsInstance
{
    hexaizedQuery: string;
    setup(): void;
    hexaizeQuery(query: string): string;
    foundMatch(bytecode: string): boolean;
}

type SearchUtilsConstructor = new (parameters: { query: string }) => SearchUtilsInstance;

const require = createRequire(import.meta.url);
const SearchUtils = require('evmap/utils/search-utils.js') as SearchUtilsConstructor;

export const MAX_QUERY_LENGTH = 2048;
export const MAX_QUERY_TOKENS = 32;

const SIGNATURE_RE = /^[A-Za-z_$][\w$]*\([\w$\[\], ()]*\)$/;
const HEX_PATTERN_RE = /^0[xX][0-9a-fA-F.\[\]{}()|*+?,\-]+$/;
// A group containing a quantifier that is itself quantified: (a+)+, (a*){2,}
const NESTED_QUANTIFIER_RE = /\([^()]*[*+?}][^()]*\)[*+{]/;

export type TokenKind = 'signature' | 'hex';

export interface QueryToken
{
    raw: string;
    kind: TokenKind;
    /** Bare lowercase hex; filled in from SearchUtils for signatures. */
    hex: string;
}

export interface HexaizedQuery
{
    query: string;
    hexaizedQuery: string;
    tokens: QueryToken[];
}

export interface Matcher
{
    query: string;
    hexaizedQuery: string;
    matches(bytecode: string | null | undefined): boolean;
}

export class QueryError extends Error
{
    readonly position: number | undefined;

    constructor(message: string, position?: number)
    {
        super(position === undefined ? message : `${message} at position ${position}`);
        this.name = 'QueryError';
        this.position = position;
    }
}

type LexToken =
    | { type: 'token'; body: string; position: number }
    | { type: 'and' | 'or' | '!' | '(' | ')'; position: number };

function tokenize(query: string): LexToken[]
{
    const tokens: LexToken[] = [];
    let i = 0;
    while (i < query.length)
    {
        const ch = query[i] as string;
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r')
        {
            i++;
            continue;
        }
        if (query.startsWith('<<', i))
        {
            const end = query.indexOf('>>', i + 2);
            if (end === -1)
            {
                throw new QueryError("unterminated '<<' token", i);
            }
            const body = query.slice(i + 2, end).trim();
            if (body.includes('<') || body.includes('>'))
            {
                throw new QueryError("token body cannot contain '<' or '>'", i);
            }
            tokens.push({ type: 'token', body, position: i });
            i = end + 2;
            continue;
        }
        if (query.startsWith('&&', i))
        {
            tokens.push({ type: 'and', position: i });
            i += 2;
            continue;
        }
        if (query.startsWith('||', i))
        {
            tokens.push({ type: 'or', position: i });
            i += 2;
            continue;
        }
        if (ch === '!' || ch === '(' || ch === ')')
        {
            tokens.push({ type: ch, position: i });
            i++;
            continue;
        }
        throw new QueryError(`unexpected character '${ch}'`, i);
    }
    return tokens;
}

function classifyBody(body: string, position: number): QueryToken
{
    if (body.length === 0)
    {
        throw new QueryError('empty token', position);
    }
    if (HEX_PATTERN_RE.test(body))
    {
        const hex = body.slice(2);
        if (NESTED_QUANTIFIER_RE.test(hex))
        {
            throw new QueryError('hex pattern contains a nested quantifier', position);
        }
        try
        {
            new RegExp(hex);
        }
        catch (error)
        {
            const reason = error instanceof Error ? error.message : String(error);
            throw new QueryError(`hex pattern is not a valid regular expression (${reason})`, position);
        }
        return { raw: body, kind: 'hex', hex: hex.toLowerCase() };
    }
    if (SIGNATURE_RE.test(body))
    {
        // The selector is filled in by hexaizeQuery() from SearchUtils' own derivation.
        return { raw: body, kind: 'signature', hex: '' };
    }
    throw new QueryError(`token '${body}' is neither a function signature nor a 0x hex pattern`, position);
}

/**
 * Validates the query grammar. Returns the list of `<< >>` tokens in order.
 * Throws QueryError on any violation.
 */
export function parseQuery(query: string): QueryToken[]
{
    if (typeof query !== 'string' || query.trim().length === 0)
    {
        throw new QueryError('query is empty');
    }
    if (query.length > MAX_QUERY_LENGTH)
    {
        throw new QueryError(`query exceeds ${MAX_QUERY_LENGTH} characters`);
    }

    const tokens = tokenize(query);
    const found: QueryToken[] = [];
    let index = 0;

    function peek(): LexToken | undefined
    {
        return tokens[index];
    }

    function expect(type: LexToken['type']): void
    {
        const token = tokens[index];
        if (!token || token.type !== type)
        {
            const where = token ? token.position : query.length;
            throw new QueryError(`expected '${type}'`, where);
        }
        index++;
    }

    function parseTerm(): void
    {
        const token = peek();
        if (!token)
        {
            throw new QueryError('unexpected end of query', query.length);
        }
        if (token.type === '!')
        {
            index++;
            const next = peek();
            if (!next || next.type !== 'token')
            {
                throw new QueryError("'!' must be followed directly by a '<< >>' token", token.position);
            }
        }
        const current = peek() as LexToken;
        if (current.type === 'token')
        {
            index++;
            found.push(classifyBody(current.body, current.position));
            return;
        }
        if (current.type === '(')
        {
            index++;
            parseExpression();
            expect(')');
            return;
        }
        throw new QueryError(`unexpected '${current.type}'`, current.position);
    }

    function parseExpression(): void
    {
        parseTerm();
        let next = peek();
        while (next && (next.type === 'and' || next.type === 'or'))
        {
            index++;
            parseTerm();
            next = peek();
        }
    }

    parseExpression();
    const trailing = tokens[index];
    if (trailing)
    {
        throw new QueryError(`unexpected '${trailing.type}'`, trailing.position);
    }
    if (found.length > MAX_QUERY_TOKENS)
    {
        throw new QueryError(`query exceeds ${MAX_QUERY_TOKENS} tokens`);
    }
    return found;
}

function buildSearchUtils(query: string): SearchUtilsInstance
{
    const searchUtils = new SearchUtils({ query });
    searchUtils.setup();
    return searchUtils;
}

/**
 * Validates the query and returns its hexaized form as SearchUtils sees it,
 * plus the per-token breakdown.
 */
export function hexaizeQuery(query: string): HexaizedQuery
{
    const tokens = parseQuery(query);
    const searchUtils = buildSearchUtils(query);

    // Fill in signature selectors from the scanner's own derivation so the
    // two never disagree.
    for (const token of tokens)
    {
        if (token.kind === 'signature')
        {
            token.hex = searchUtils.hexaizeQuery(`<<${token.raw}>>`).slice(1, -1);
        }
    }

    return {
        query,
        hexaizedQuery: searchUtils.hexaizedQuery,
        tokens
    };
}

/**
 * Validates the query once and returns a reusable matcher.
 */
export function createMatcher(query: string): Matcher
{
    parseQuery(query);
    const searchUtils = buildSearchUtils(query);
    return {
        query,
        hexaizedQuery: searchUtils.hexaizedQuery,
        matches(bytecode)
        {
            return searchUtils.foundMatch(bytecode || '');
        }
    };
}
