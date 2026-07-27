export interface CatalogEntry {
  sku: string;
  version: number;
}

/** Synchronize a large catalog batch while retaining one source-chunk identity. */
export async function synchronizeCatalogBatch(
  entries: CatalogEntry[],
): Promise<void> {
  const accepted = entries.filter((entry) => entry.version > 0);
  const batches: CatalogEntry[][] = [];

  for (let offset = 0; offset < accepted.length; offset += 25) {
    batches.push(accepted.slice(offset, offset + 25));
  }

  for (const batch of batches) {
    await reserveCatalogCapacity(batch.length);
    await writeCatalogEntries(batch);
    await publishCatalogChanges(batch.map((entry) => entry.sku));
  }

  const synchronizedSkus = accepted.map((entry) => entry.sku);
  await verifyCatalogSynchronization(synchronizedSkus);
  await releaseCatalogCapacity();
}

declare function reserveCatalogCapacity(count: number): Promise<void>;
declare function writeCatalogEntries(entries: CatalogEntry[]): Promise<void>;
declare function publishCatalogChanges(skus: string[]): Promise<void>;
declare function verifyCatalogSynchronization(skus: string[]): Promise<void>;
declare function releaseCatalogCapacity(): Promise<void>;
