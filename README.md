# PaeStream

Servidor local de cinema privado (watch party) para 2 pessoas: host escolhe o filme no PC, convidada assiste sincronizado pelo navegador. Inclui HLS via FFmpeg, legendas, chat, WebRTC (voz/video) e tunel Cloudflare opcional.

## Requisitos

- Windows (testado neste projeto)
- [Node.js](https://nodejs.org/) 18+
- FFmpeg e ffprobe no PATH (ou instalados via WinGet / pasta `bin/`)

## Instalacao

```bash
npm install
```

Coloque os filmes em `movies/` (mp4, mkv, avi, mov, webm, m4v). Legendas `.srt` / `.vtt` na mesma pasta do filme sao detectadas automaticamente.

## Como usar

1. Rode `iniciar-cinema.bat` ou `npm start`.
2. Abra `http://localhost:3000` no PC host (vira host automaticamente).
3. Escolha o filme na biblioteca e compartilhe o link de convidada (LAN ou tunel HTTPS).
4. Host mobile: use o QR/link de Host Mobile (codigo de pareamento de uso unico; nao compartilhe com a convidada).

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
- Link de convidada da acesso a sessao (assista/chat). Trate como secreto de sessao.
- Token longo nao vai mais na URL do host mobile.

## Estrutura

```
server/     backend (Express, Socket.io, FFmpeg HLS)
public/     interface web
shared/     contrato API / eventos
movies/     biblioteca local
data/       config local (nao versionada)
```
