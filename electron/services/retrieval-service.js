'use strict';

class RetrievalService {
  searchConfirmedMemories() {
    throw new Error('RetrievalService.searchConfirmedMemories must be implemented');
  }
}

class SqliteRetrievalService extends RetrievalService {
  constructor(database) {
    super();
    this.database = database;
  }

  searchConfirmedMemories(query, filters = {}) {
    const keywordMatches = this.database.searchMemories(query, 40);
    const scoped = this.database.listMemories({
      enabled: true,
      countryCode: filters.countryCode || '',
      storeId: filters.storeId || '',
      businessModule: filters.businessModule || '',
    });
    const merged = new Map();
    for (const item of [...keywordMatches, ...scoped]) {
      if (item.userConfirmed === false || item.enabled === false) continue;
      merged.set(item.id, item);
      if (merged.size >= 40) break;
    }
    return [...merged.values()];
  }
}

module.exports = { RetrievalService, SqliteRetrievalService };
