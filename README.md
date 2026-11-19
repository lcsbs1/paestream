# PaeStream

Servidor local de cinema privado (watch party) para 2 pessoas: host escolhe o filme no PC, convidada assiste sincronizado pelo navegador. Inclui HLS via FFmpeg, legendas, WebRTC (voz/camera) e tunel Cloudflare opcional. A conversa e so por voz e camera — sem chat de texto.

## Requisitos

- Windows (testado neste projeto)
- [Node.js](https://nodejs.org/) 18+
- FFmpeg e ffprobe no PATH (ou instalados via WinGet / pasta `bin/`)
- Conta TURN (Metered Open Relay gratis) para voz/camera entre regioes distintas

## Instalacao

```bash
npm install
```

Coloque os filmes em `movies/` (mp4, mkv, avi, mov, webm, m4v). Legendas `.srt` / `.vtt` na mesma pasta do filme sao detectadas automaticamente.

Copie `.env.example` para `.env` e configure o TURN (obrigatorio se host e convidada estiverem em redes/cidades diferentes):

```env
PAESTREAM_METERED_APP_NAME=seu-app
PAESTREAM_METERED_TURN_API_KEY=sua-api-key
```

- `PAESTREAM_METERED_APP_NAME`: so o nome curto do app (ex. `paestream`), **sem** `.metered.live`
- Nao cole a API key no chat nem no git — `.env` ja esta no `.gitignore`

Conta gratis: [Metered Open Relay](https://www.metered.ca/tools/openrelay/) (~20 GB/mes).

## Como usar

1. Rode `iniciar-cinema.bat` ou `npm start`.
2. No console deve aparecer `TURN ativo (metered)`. Se aparecer `so STUN`, o `.env` nao foi lido ou a key esta errada.
3. Abra `http://localhost:3000` no PC host (vira host automaticamente).
4. Escolha o filme e compartilhe o **link Cloudflare HTTPS** da convidada (nao use IP da LAN para mic/camera).
5. Host mobile: use o QR/link de Host Mobile (codigo de pareamento de uso unico; nao compartilhe com a convidada).

### Voz e camera

O filme/sync usa o tunel Cloudflare. **Voz e camera sao WebRTC P2P** entre os dois navegadores e **nao** passam pelo tunel. Por isso o TURN e necessario entre regioes.

1. Os dois entram na sessao (host em `localhost`, convidada no link `https://...` do Cloudflare).
2. Cada um clica **Mic** (e **Camera** se quiser). Um lado sozinho ja deve ser ouvido pelo outro.
3. Deixe **Modo WhatsApp/FaceTime** desligado para usar a voz do PaeStream.
4. O badge da chamada deve ir para algo como `Conectado` / `TURN ativo`.

Alternativas de TURN (em vez do Metered):

```bash
set PAESTREAM_TURN_URLS=turn:seu-servidor:3478,turns:seu-servidor:443?transport=tcp
set PAESTREAM_TURN_USERNAME=usuario
set PAESTREAM_TURN_CREDENTIAL=senha
npm start
```

Ou JSON completo: `PAESTREAM_ICE_SERVERS_JSON=[{...}]`.

Para desligar o tunel Cloudflare:

```bash
set PAESTREAM_DISABLE_TUNNEL=1
npm start
```

## Scripts

| Comando | Função |
|---------|--------|
| `npm start` | Sobe o servidor na porta 3000 |
| `npm test` | Roda a suite de verificacao |

## Seguranca (resumo)

- Acoes de host exigem token; `/api/movies` tambem.
- Respostas publicas nao incluem caminhos absolutos do disco.
- Link de convidada da acesso a sessao (filme + voz/camera). Trate como secreto de sessao.
- Token longo nao vai mais na URL do host mobile.

## Estrutura

```
server/     backend (Express, Socket.io, FFmpeg HLS)
public/     interface web
shared/     contrato API / eventos
movies/     biblioteca local
data/       config local (nao versionada)
```
