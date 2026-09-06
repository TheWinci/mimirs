// Use each pinned engine's production search implementation in a persistent process.
// Run from Bun. Arguments: version engine project queries output passes.
const [version, engine, project, queryFile, output, passesText = '3'] = process.argv.slice(2);
const queries = await Bun.file(queryFile).json();
let search: (query: string) => Promise<any[]>;
let close: () => any;
const openStart = performance.now();
if (version === 'v1') {
  const { RagDB } = await import(`${engine}/src/db/index.ts`);
  const { loadConfig } = await import(`${engine}/src/config/index.ts`);
  const { search: runSearch } = await import(`${engine}/src/search/hybrid.ts`);
  const config = await loadConfig(project);
  const db = new RagDB(project);
  search = (q) => runSearch(q, db, 20, 0, config.hybridWeight, config.generated);
  close = () => db.close();
} else if (version === 'v2') {
  const { openReadOnlyProjectSearch } = await import(`${engine}/src/internals/search/read-only-project-search.ts`);
  const session = await openReadOnlyProjectSearch(project);
  search = async (q) => (await session.search({query:q,maxResults:20})).source;
  close = () => session.close();
} else throw new Error(`unsupported engine ${version}`);
const openMs = performance.now() - openStart;
const warmStart = performance.now();
await search(queries[0].query);
const firstSearchMs = performance.now() - warmStart;
const cases = [];
try {
  for (let pass = 0; pass < Number(passesText); pass++) {
    for (let i = 0; i < queries.length; i++) {
      const start = performance.now();
      const hits = await search(queries[i].query);
      const ms = performance.now()-start;
      cases.push({pass,index:i,ms,hits:pass === 0 ? hits : hits.map(h => ({path:h.path,score:h.score}))});
    }
  }
  await Bun.write(output, JSON.stringify({version,openMs,firstSearchMs,cases}));
} finally { await close(); }
