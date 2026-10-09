# Testes

Requisitos: Node ≥ 20 (testado no Node 24). Sem `npm install` — nenhum pacote é necessário.

```bash
npm test                              # = node --test "tests/**/*.test.js"
node --test "tests/**/*.test.js"      # equivalente sem npm
node tools/check.mjs                  # sintaxe de todos os .js, manifest, referências e imports
```

> O documento de arquitetura sugere `node --test tests/`. A partir do Node 22 o argumento
> posicional é um *glob* e diretórios não são mais aceitos, por isso usamos o glob acima.

| Arquivo | Cobre |
|---|---|
| `text-normalize.test.js` | `normalize`, `tokens`, `dice`, `coverage`, `parseDuration`, `parseViews`, `cleanSpotifyTitle` |
| `clip-ranker.test.js` | `buildQuery`, `scoreCandidate`, `rankCandidates` (calibração e ordem oficial > lyric > Topic > cover > reaction) |
| `youtube-search.test.js` | `extractJsonAssignment` (com `};` em string), `parseSearchData` com fixtures reais, fallback `deepCollect`, `lockupViewModel`, watch page |
| `playback-tracker.test.js` | `diffPlayback` (troca, pause/play, seek, repeat-one, 204, anúncio), `toSnapshot`, `computeNextDelay`, `shouldRun` |
| `yt-to-spotify.test.js` | `parseVideoTitle`, `cleanChannelName`, `scoreTrackMatch`, `isLikelyMusic`, helpers da Data API |
| `sw-integration.test.js` | service worker inteiro com `chrome.*` e `fetch` simulados: poll → clipe → aba reutilizada, autoplay x navegação manual, aba fechada, 401/refresh single-flight, master switch |

## Fixtures

`fixtures/yt-search-*.html` e `fixtures/yt-watch-*.html` são HTMLs reais do YouTube (baixados com
`hl=en` e o filtro "Vídeos" `sp=EgIQAQ%253D%253D`). Quando o YouTube mudar o HTML e o parser quebrar,
salve uma página nova aqui (navegador → "Salvar como" → "Somente HTML", ou `curl` com
`Accept-Language: en-US`) e ajuste `parseSearchData` até os testes passarem.
