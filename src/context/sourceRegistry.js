export const ContextSourceType = Object.freeze({
  OFFICIAL_CLUB: "OFFICIAL_CLUB",
  OFFICIAL_LEAGUE: "OFFICIAL_LEAGUE",
  OFFICIAL_FEDERATION: "OFFICIAL_FEDERATION",
  REPUTABLE_MEDIA: "REPUTABLE_MEDIA"
});

export const ContextFetchMode = Object.freeze({ HTML_INDEX: "HTML_INDEX", RSS: "RSS" });

export const DEFAULT_CONTEXT_SOURCES = Object.freeze([
  {
    id: "tottenham-official", name: "Tottenham Hotspur", type: ContextSourceType.OFFICIAL_CLUB,
    baseUrl: "https://www.tottenhamhotspur.com/news/", reliability: null,
    competitions: ["PL"], teams: ["Tottenham Hotspur FC"], enabled: true,
    fetchMode: ContextFetchMode.HTML_INDEX, linkPattern: "/news/"
  },
  {
    id: "inter-official", name: "Inter", type: ContextSourceType.OFFICIAL_CLUB,
    baseUrl: "https://www.inter.it/en/news", reliability: null,
    competitions: ["SA"], teams: ["FC Internazionale Milano"], enabled: true,
    fetchMode: ContextFetchMode.HTML_INDEX, linkPattern: "/en/news/"
  },
  {
    id: "premier-league-official", name: "Premier League", type: ContextSourceType.OFFICIAL_LEAGUE,
    baseUrl: "https://www.premierleague.com/en/news", reliability: null,
    competitions: ["PL"], teams: [], enabled: false,
    fetchMode: ContextFetchMode.HTML_INDEX, linkPattern: "/en/news/"
  },
  {
    id: "ligue1-official", name: "Ligue 1", type: ContextSourceType.OFFICIAL_LEAGUE,
    baseUrl: "https://ligue1.com/en/articles", reliability: null,
    competitions: ["FL1"], teams: [], enabled: true,
    fetchMode: ContextFetchMode.HTML_INDEX, linkPattern: "/en/articles/"
  },
  {
    id: "lega-serie-a-official", name: "Lega Serie A", type: ContextSourceType.OFFICIAL_LEAGUE,
    baseUrl: "https://en.legaseriea.it/news", reliability: null,
    competitions: ["SA"], teams: [], enabled: true,
    fetchMode: ContextFetchMode.HTML_INDEX, linkPattern: "/serie-a/news/"
  }
]);

function validSource(source) {
  return source && source.id && source.name && source.baseUrl &&
    Object.values(ContextSourceType).includes(source.type) &&
    Object.values(ContextFetchMode).includes(source.fetchMode);
}

export function createSourceRegistry({ sources = DEFAULT_CONTEXT_SOURCES, enabledIds = null, reliabilityByType = {} } = {}) {
  const enabled = enabledIds?.length ? new Set(enabledIds) : null;
  return sources.filter(validSource).map(source => ({
    ...source,
    reliability: Math.max(0, Math.min(100, Number(reliabilityByType[source.type] ?? source.reliability) || 0)),
    competitions: [...new Set(source.competitions || [])],
    teams: [...new Set(source.teams || [])],
    enabled: Boolean(source.enabled && (!enabled || enabled.has(source.id)))
  }));
}

export function sourcesForFixtures(registry, fixtures = []) {
  const competitions = new Set(fixtures.map(fixture => fixture.competitionCode));
  const teams = new Set(fixtures.flatMap(fixture => [fixture.home, fixture.away]));
  return registry.filter(source => source.enabled &&
    source.competitions.some(code => competitions.has(code)) &&
    (!source.teams.length || source.teams.some(team => teams.has(team))));
}

export function combineContextSourceRegistries(webSources = [], telegramSources = []) {
  return [...webSources, ...telegramSources];
}
