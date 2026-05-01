---
date: 2026-04-29
topic: yt-dlp bot detection mitigations 2026 — what we need installed in podcast-brief Phase 1 and Phase 2
tags: [yt-dlp, youtube, bot-detection, deno, curl_cffi, po-token, sabr, mullvad, wireguard, residential-proxy]
status: validated
sources_count: 14
---

# yt-dlp Bot Detection Mitigations — Podcast-Brief Phase 1 & Phase 2 Install Manifest

## Research Question

What does the podcast-brief yt-dlp wrapper need installed and configured, in each phase, to reliably download audio-only YouTube content given YouTube's 2025–2026 bot-detection escalations (SABR, PO Tokens, JS challenges, datacenter-IP scoring)?

- **Phase 1**: yt-dlp runs in-process inside the existing Railway worker on Railway IPs, no proxy.
- **Phase 2**: yt-dlp runs in a separate Railway service behind a Mullvad WireGuard sidecar.

## Executive Summary

Three things have changed in YouTube's defences since the last time the codebase was audited, and each one demands a specific install on our worker image:

1. **External JS runtime is now mandatory.** As of yt-dlp **2025.11.12**, YouTube's player-JS challenges (`n` and signature) can no longer be solved by yt-dlp's built-in Python interpreter for most clients. **Deno ≥ 2.0.0** is the recommended, default-enabled runtime. Without it, yt-dlp falls back to **only the `android_vr` client**, which is severely limited and missing many audio formats. ([yt-dlp #14404](https://github.com/yt-dlp/yt-dlp/issues/14404), [yt-dlp #15012](https://github.com/yt-dlp/yt-dlp/issues/15012), [EJS Wiki](https://github.com/yt-dlp/yt-dlp/wiki/EJS))

2. **TLS / HTTP-fingerprint impersonation matters now.** yt-dlp ships `--impersonate` powered by **curl_cffi**. The `yt-dlp[default]` pip extra includes it, but only on the right binary builds; the standalone Linux zipimport build does not. Use the pip install path on Railway. ([yt-dlp README](https://github.com/yt-dlp/yt-dlp), [curl_cffi targets](https://curl-cffi.readthedocs.io/en/latest/impersonate/targets.html))

3. **Player client choice changed in early 2026.** Default is now `android_vr,ios_downgraded,web,web_safari` (commit [309b03f](https://github.com/yt-dlp/yt-dlp/commit/309b03f2ad09fcfcf4ce81e757f8d3796bb56add)); `android_sdkless` was removed; `ios` silently drops cookie auth. For an audio-only, no-cookie, server-side use case the working combo reported in April 2026 production setups is `web,mweb,android` or relying on the new defaults plus Deno. ([Fixing yt-dlp in Docker — DEV.to, April 2026](https://dev.to/nareshipme/fixing-yt-dlp-in-docker-n-challenge-ejs-scripts-deno-2x-and-the-playerclientios-cookie-trap-54d6))

For our **audio-only / `bestaudio[ext=m4a]`** pipeline:
- **Phase 1 must install**: `python3` + `pip` + `yt-dlp[default]` (pulls in curl_cffi + yt-dlp-ejs) + `deno` 2.x + `ffmpeg` (used by Deepgram fallback paths today; not strictly needed for `m4a` pass-through). No PO Token provider, no proxy. Expected reliability: usable but you will hit `Sign in to confirm you're not a bot` on a meaningful fraction of videos because Railway IPs are datacenter-flagged.
- **Phase 2 adds**: a `gluetun` sidecar in WireGuard mode pointed at Mullvad, the downloader container joined via `network_mode: "service:gluetun"`. Expected reliability: 85–95% per published residential-proxy benchmarks; Mullvad is *not* residential but is consumer-VPN-pool IPs which YouTube treats much better than Railway / AWS / GCP datacenter ranges.
- **Optional, Phase 2.5 if Mullvad isn't enough**: bgutil-ytdlp-pot-provider sidecar (Node 20+ container on `:4416`) so the `web` client can request SABR-only formats with a valid GVS PO Token.

## Detailed Findings

### Dimension 1 — External JS runtime (Deno) is now mandatory

The 2025-11-12 release announcement is unambiguous: yt-dlp **deprecated its built-in JS interpreter** for YouTube. The relevant quotes:

> "All users who intend to use yt-dlp with YouTube are strongly encouraged to install one of the supported JS runtimes."
> "Format availability will be limited, and severely so in some cases […] expected to worsen as time goes on." — [#15012](https://github.com/yt-dlp/yt-dlp/issues/15012)

Supported runtimes, with version floors ([EJS Wiki](https://github.com/yt-dlp/yt-dlp/wiki/EJS)):

| Runtime  | Default? | Min version |
| -------- | -------- | ----------- |
| Deno     | yes      | 2.0.0       |
| Node     | no       | 20.0.0      |
| Bun      | no       | 1.0.31      |
| QuickJS  | no       | 2023-12-9   |

Deno was chosen as default because it is sandboxed by default (no FS / network unless granted) and ships as a single static binary. From the announcement:

> "if downloading from Deno's GitHub releases, get `deno` **not** `denort`" — [#15012](https://github.com/yt-dlp/yt-dlp/issues/15012)

**Crucial knock-on effect**: without a JS runtime, yt-dlp's *default client list* collapses to `android_vr` only ([commit 309b03f](https://github.com/yt-dlp/yt-dlp/commit/309b03f2ad09fcfcf4ce81e757f8d3796bb56add)). `android_vr` is heavily rate-limited and lacks many audio formats. So Deno isn't just optional polish — **without it, audio-only downloads will frequently return "no audio formats available."**

Recommended Dockerfile install (matches what the April-2026 DEV.to debugging trail landed on):

```dockerfile
RUN apt-get update && apt-get install -y \
      python3 python3-pip ffmpeg curl ca-certificates unzip \
 && pip3 install --break-system-packages -U "yt-dlp[default]" \
 && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh
```

Sources: [DEV.to / Fixing yt-dlp in Docker (Apr 2026)](https://dev.to/nareshipme/fixing-yt-dlp-in-docker-n-challenge-ejs-scripts-deno-2x-and-the-playerclientios-cookie-trap-54d6), [denoland/deno_docker](https://github.com/denoland/deno_docker).

### Dimension 2 — `--impersonate` and curl_cffi

`curl_cffi` is the Python binding to `curl-impersonate`, providing real Chrome/Safari/Edge/Firefox TLS + HTTP/2 fingerprints. The yt-dlp README:

> "curl_cffi (recommended) — Python binding for curl-impersonate. Provides impersonation targets for Chrome, Edge and Safari." — [README](https://github.com/yt-dlp/yt-dlp)

Install path matters:
- `pip install "yt-dlp[default]"` → bundles curl_cffi + yt-dlp-ejs. **This is the path we want.**
- `pip install "yt-dlp[default,curl-cffi]"` is also valid but redundant.
- The `yt-dlp` Linux zipimport binary and `yt-dlp_x86` Windows 32-bit do **not** include curl_cffi. — [README](https://github.com/yt-dlp/yt-dlp), [#14106](https://github.com/yt-dlp/yt-dlp/issues/14106)

Targets (current as of 2026 per [curl_cffi docs](https://curl-cffi.readthedocs.io/en/latest/impersonate/targets.html)):

| Family  | Latest         | "always-current" alias |
| ------- | -------------- | ---------------------- |
| Chrome  | `chrome146`    | `chrome`               |
| Safari  | `safari260`    | `safari`               |
| Firefox | `firefox147`   | `firefox`              |

Recommendation: pass the alias (`--impersonate chrome`) so we automatically pick up new fingerprints when curl_cffi updates. yt-dlp will pick a sensible target on its own for YouTube; we mostly need to ensure it's *installed* and *available*. Verify with `yt-dlp --list-impersonate-targets`.

### Dimension 3 — Player clients (and the cookie trap)

Default client list, post-Jan-29-2026 commit `309b03f`:

```
android_vr, ios_downgraded, web, web_safari
```

…and `android_sdkless` was removed. ([commit 309b03f](https://github.com/yt-dlp/yt-dlp/commit/309b03f2ad09fcfcf4ce81e757f8d3796bb56add))

Rules of thumb from current issues / wiki:

- **No JS runtime** → defaults collapse to `android_vr` only. Audio formats often missing. ([#16128](https://github.com/yt-dlp/yt-dlp/issues/16128))
- **`web` client** alone → "Only SABR formats available" → needs GVS PO Token to actually stream. ([PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide), [#12482](https://github.com/yt-dlp/yt-dlp/issues/12482))
- **`ios` / `ios_downgraded`** → does **not** read cookies. YouTube's iOS API uses OAuth not browser-cookie auth; passing `--cookies` is silently ignored. ([DEV.to Apr 2026](https://dev.to/nareshipme/fixing-yt-dlp-in-docker-n-challenge-ejs-scripts-deno-2x-and-the-playerclientios-cookie-trap-54d6))
- **`android` / `android_vr`** → also doesn't support account cookies. ([PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide))
- **`mweb`** → still needs PO Token for GVS.
- **Working no-cookie combo reported in April 2026 production**: `--extractor-args "youtube:player_client=web,mweb,android"` with Deno 2 installed. ([DEV.to Apr 2026](https://dev.to/nareshipme/fixing-yt-dlp-in-docker-n-challenge-ejs-scripts-deno-2x-and-the-playerclientios-cookie-trap-54d6))

**For our audio-only / no-cookies design**: leave `player_client` at default (`android_vr,ios_downgraded,web,web_safari`) until we see real failures. Add `web,mweb,android` as a documented fallback and, only if both fail, add cookies + PO token (Phase 2.5 territory).

### Dimension 4 — PO Tokens and SABR

SABR (Server-side Adaptive BitRate) is YouTube's newer streaming protocol. As of late 2025 / early 2026, YouTube increasingly **forces SABR for the `web` client**, and SABR streams require a GVS PO Token to play. Quotes:

> "Three cases require PO Tokens depending on the client: GVS (Google Video Server), Player (Innertube), Subs."
> "GVS PO Token is not required for YouTube Premium subscribers."
> "HLS live streams do not require a PO Token (excluding `ios` client)."
> "Manually extracting PO Tokens is no longer recommended. YouTube now binds PO Tokens to the video ID, so a new token needs to be generated for each video." — [PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)

Required tokens by client:

| Client       | GVS | Player | Cookies? |
| ------------ | --- | ------ | -------- |
| `web`        | yes | no     | yes      |
| `mweb`       | yes | no     | yes      |
| `android`    | varies | varies | **no** |
| `ios`        | varies | varies | **no** |
| `android_vr` | none reported | none reported | no |

**Recommended provider**: [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) — a yt-dlp maintainer-endorsed Node/Deno service that runs on `127.0.0.1:4416` and the bgutil yt-dlp plugin auto-discovers it.

Container install:

```bash
docker run --name bgutil-provider -d --init \
  brainicism/bgutil-ytdlp-pot-provider:latest
```

Plugin install on the worker:

```bash
python3 -m pip install -U bgutil-ytdlp-pot-provider
```

Requires yt-dlp ≥ **2025.05.22**, Node ≥ 20 (or Deno ≥ 2). With a custom port:

```
yt-dlp --extractor-args "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416" <URL>
```

**For our use case**: skip in Phase 1 and Phase 2. Add only if Mullvad-routed, Deno-equipped downloads still hit SABR-only failures often enough to matter. Adding bgutil is a third sidecar and an ongoing dependency to maintain.

### Dimension 5 — IP reputation: Railway vs Mullvad vs residential

Industry consensus (multiple 2026 sources) on success rates:

| Egress class            | Reported success | Notes                          |
| ----------------------- | ---------------- | ------------------------------ |
| Datacenter (AWS/GCP/Railway) | 20–40% | Well-known ASNs, flagged       |
| Consumer VPN (Mullvad)  | not benchmarked publicly, but treated more like end-user IPs than AWS | Shared exit pool — abused by other users, will occasionally CAPTCHA |
| Residential proxy (Bright Data, Oxylabs, Smartproxy) | 85–95% | Real ISP IPs, sticky-session capable |
| Mobile / ISP            | highest          | Most expensive                 |

Sources: [glorycloud.com/yt-dlp-proxy](https://www.glorycloud.com/blog/yt-dlp-scarpe-videos-proxy/), [proxy001.com](https://proxy001.com/blog/youtube-proxy-prevent-server-ip-blocks-after-deploying-yt-dlp-style-server-workloads), [roundproxies.com 2026 guide](https://roundproxies.com/blog/yt-dlp/), [Oxylabs YouTube docs](https://developers.oxylabs.io/video-data/high-bandwidth-proxies/youtube-downloader-yt_dlp-integration).

**Phase-2 implication**: Mullvad-via-WireGuard is meaningfully better than Railway IPs but not equivalent to a residential proxy. We should plan our SLO numbers accordingly and keep "swap to residential proxy" as a Phase 3 lever.

### Dimension 6 — Mullvad WireGuard in Docker (gluetun)

The 2026 stack is **gluetun (`qmcgaw/gluetun`)** as the sidecar; the wireguard-go binary baked into a custom image is the older pattern. Setup ([gluetun-wiki Mullvad](https://github.com/qdm12/gluetun-wiki/blob/main/setup/providers/mullvad.md)):

1. Generate a WireGuard config in Mullvad's account portal — you get a `PrivateKey` and an `Address`.
2. Set env vars on gluetun:
   - `VPN_SERVICE_PROVIDER=mullvad`
   - `VPN_TYPE=wireguard`
   - `WIREGUARD_PRIVATE_KEY=<base64>`
   - `WIREGUARD_ADDRESSES=10.x.y.z/32`
   - `SERVER_CITIES=Amsterdam` (or country/region of choice)
3. Run the downloader with `network_mode: "service:gluetun"` so all its traffic egresses via the tunnel.

```yaml
services:
  gluetun:
    image: qmcgaw/gluetun
    cap_add: [NET_ADMIN]
    devices: ["/dev/net/tun:/dev/net/tun"]
    environment:
      VPN_SERVICE_PROVIDER: mullvad
      VPN_TYPE: wireguard
      WIREGUARD_PRIVATE_KEY: ${MULLVAD_WG_PRIVATE_KEY}
      WIREGUARD_ADDRESSES: ${MULLVAD_WG_ADDRESS}
      SERVER_CITIES: Amsterdam
  downloader:
    build: .
    network_mode: "service:gluetun"
    depends_on: [gluetun]
```

**2026 gotcha**: Mullvad ended OpenVPN support on Jan 15 2026. WireGuard is now the *only* protocol Mullvad sells. ([Mullvad](https://mullvad.net/en/help/tag/wireguard), [gluetun-wiki Mullvad](https://github.com/qdm12/gluetun-wiki/blob/main/setup/providers/mullvad.md)) Don't follow any 2024-vintage OpenVPN tutorial.

**Railway fit**: Railway supports Docker compose deployments, so this is a "private Railway service that builds a multi-container compose project" rather than a single-image deploy. If we want single-container, the alternative is to bake `wireguard-tools` + `wg-quick` into our own Dockerfile and `wg-quick up wg0` on container start — more brittle, more sysctl/capability faffing. **Recommendation: gluetun.**

### Dimension 7 — Cookies on a headless server

For our two-phase plan we are **not** logging into a Google account — that's a meaningful additional trust / safety footprint and cookies expire fast. The data:

> "Cookies expire in approximately 2 weeks, requiring re-extraction" — [DEV.to "6 ways to get cookies"](https://dev.to/osovsky/6-ways-to-get-youtube-cookies-for-yt-dlp-in-2026-only-1-works-2cnb)

> "YouTube rotates account cookies frequently on open YouTube browser tabs as a security measure. To export cookies that will remain working with yt-dlp […] open a new private browsing/incognito window and log into YouTube, then in the same window and tab, navigate to https://www.youtube.com/robots.txt, export youtube.com cookies from the browser, and close the private browsing/incognito window so that the session is never opened in the browser again." — [yt-dlp wiki via 2026 search corpus](https://github.com/yt-dlp/yt-dlp/wiki/Extractors)

If Phase 2 still has high failure rates, the next lever is a *dedicated burner Google account* + the incognito + robots.txt cookie-export procedure, run weekly via a manual ops chore. **Don't add this unless metrics force it.**

## Comparison Table — what each phase needs

| Component                                | Phase 1 (Railway worker) | Phase 2 (Mullvad sidecar) | Phase 2.5 (PO Token) |
| ---------------------------------------- | ------------------------ | ------------------------- | -------------------- |
| `python3` + `pip`                        | yes                      | yes                       | yes                  |
| `yt-dlp[default]` (incl. curl_cffi, yt-dlp-ejs) | yes               | yes                       | yes                  |
| `deno` ≥ 2.0.0                           | **yes**                  | **yes**                   | yes                  |
| `ffmpeg`                                 | yes (audio passthrough is m4a, but keep for safety) | yes | yes |
| `gluetun` sidecar (WireGuard / Mullvad)  | no                       | **yes**                   | yes                  |
| `bgutil-ytdlp-pot-provider` sidecar      | no                       | no                        | **yes** (`:4416`)    |
| `bgutil-ytdlp-pot-provider` plugin (pip) | no                       | no                        | **yes**              |
| Cookies                                  | no                       | no                        | **maybe** (only if SABR + `web` client is in the mix) |
| `--impersonate chrome`                   | recommended              | recommended               | recommended          |
| `--extractor-args youtube:player_client=…` | leave default; `web,mweb,android` as fallback | same | `web` + cookies + PO token |

## Best Practices

- **Pin to a known-good yt-dlp version per release** but auto-update the container daily. yt-dlp ships as fast as YouTube changes; pinning forever guarantees breakage. Use `pip install -U "yt-dlp[default]"` in the Docker image (or run `yt-dlp -U` on container start, as the DEV.to fix recommends — adds ~2-3s but immunizes against weekly YouTube changes). ([DEV.to Apr 2026](https://dev.to/nareshipme/fixing-yt-dlp-in-docker-n-challenge-ejs-scripts-deno-2x-and-the-playerclientios-cookie-trap-54d6))
- **Always `pip install "yt-dlp[default]"`** — never the bare zipimport binary on Linux. The bare binary lacks curl_cffi.
- **Always install Deno on the same image as yt-dlp.** Without it, default client list collapses to `android_vr` and audio formats commonly disappear.
- **Use the latest curl_cffi alias (`chrome`, not `chrome-110`)** so updates carry forward.
- **Keep `noplaylist: true`** (already in our `download_video.py`) to defeat playlist-URL-based fan-out.
- **Set `concurrent_fragment_downloads` low** for audio-only — m4a is one stream, fragment concurrency doesn't help and can look bot-like. Drop from 4 to 1 for the YouTube path.
- **Phase 2: do not rely on gluetun's HTTP proxy mode.** Use `network_mode: "service:gluetun"`. The HTTP proxy adds another fingerprint surface.
- **Phase 2: enable gluetun's kill switch** (default on) so that if the tunnel drops, the downloader cannot leak via Railway's IP and reveal that we have datacenter fallback.

## Common Pitfalls

- **"Sign in to confirm you're not a bot" on Railway IPs.** This is *the* canonical datacenter-IP rejection. No yt-dlp flag fixes it. Fix is Phase 2 (Mullvad). ([#13067](https://github.com/yt-dlp/yt-dlp/issues/13067), [proxy001.com](https://proxy001.com/blog/youtube-proxy-prevent-server-ip-blocks-after-deploying-yt-dlp-style-server-workloads))
- **`player_client=ios` silently ignores `--cookies`.** If we ever bolt on cookies, do not pair them with the iOS client. ([DEV.to Apr 2026](https://dev.to/nareshipme/fixing-yt-dlp-in-docker-n-challenge-ejs-scripts-deno-2x-and-the-playerclientios-cookie-trap-54d6))
- **`web` client will return SABR-only formats.** If you see `Only SABR formats available`, that's the GVS-PO-Token signal — not a yt-dlp bug. ([#12482](https://github.com/yt-dlp/yt-dlp/issues/12482), [#13968](https://github.com/yt-dlp/yt-dlp/issues/13968))
- **Bare `yt-dlp` Linux binary lacks curl_cffi.** `--impersonate` will silently no-op. Always go via pip. ([README](https://github.com/yt-dlp/yt-dlp))
- **Deno binary vs `denort`.** From the GitHub releases page, grab `deno`, not `denort` — yt-dlp will not accept the latter. ([#15012](https://github.com/yt-dlp/yt-dlp/issues/15012))
- **Mullvad OpenVPN tutorials are dead.** Mullvad killed OpenVPN Jan 15 2026; only WireGuard configs work now.
- **PO Tokens are now per-video.** Don't try to manually paste one — it'll work for one video and break on the next. Use the bgutil provider service (or skip PO entirely). ([PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide))
- **Do not set `concurrent_fragment_downloads` high for YouTube audio.** Today our wrapper uses `4`; for audio-only m4a this is wasted and adds traffic shape that looks botty. Set to 1 in the YouTube branch.

## Confidence Assessment

| Claim                                                                  | Confidence | Why                                  |
| ---------------------------------------------------------------------- | ---------- | ------------------------------------ |
| Deno 2.x is required for full YouTube support post-2025.11.12         | **High**   | Direct yt-dlp maintainer announcement |
| `yt-dlp[default]` includes curl_cffi + yt-dlp-ejs                      | **High**   | README + EJS wiki                    |
| Default player clients changed to `android_vr,ios_downgraded,web,web_safari` in Jan 2026 | **High** | Commit message |
| `ios` client ignores cookies                                           | **High**   | Multiple sources, official PO guide  |
| Datacenter IPs achieve 20–40% success                                  | **Medium** | Numbers come from proxy vendors who have an interest in selling |
| Mullvad WireGuard meaningfully outperforms Railway IPs for YouTube     | **Medium** | Inferred from "consumer VPN > AWS" pattern; no direct A/B published |
| bgutil-ytdlp-pot-provider works with audio-only on `web` client        | **Medium** | Provider docs claim it; recent issue [#16082](https://github.com/yt-dlp/yt-dlp/issues/16082) shows it can still fail with "n-challenge failure" — Deno being installed is what fixes that |
| Cookies via "incognito + robots.txt" survives 2 weeks                  | **Medium** | yt-dlp wiki guidance; users in [#11585](https://github.com/yt-dlp/yt-dlp/issues/11585) report shorter lifetimes |
| OpenVPN dead at Mullvad in 2026                                        | **High**   | Mullvad announcement                 |

## Sources

### Official Documentation (yt-dlp)
- [yt-dlp README](https://github.com/yt-dlp/yt-dlp)
- [PO Token Guide (Wiki)](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
- [EJS — External JavaScript Runtime (Wiki)](https://github.com/yt-dlp/yt-dlp/wiki/EJS)
- [Issue #15012 — JS runtime now required](https://github.com/yt-dlp/yt-dlp/issues/15012)
- [Issue #14404 — Upcoming new requirements for YouTube](https://github.com/yt-dlp/yt-dlp/issues/14404)
- [Issue #12482 — `web` only has SABR formats](https://github.com/yt-dlp/yt-dlp/issues/12482)
- [Issue #13968 — SABR forced despite cookies](https://github.com/yt-dlp/yt-dlp/issues/13968)
- [Issue #16082 — n-challenge failure even with bgutil](https://github.com/yt-dlp/yt-dlp/issues/16082)
- [Issue #16128 — DASH audio-only formats missing in 2026.03.03](https://github.com/yt-dlp/yt-dlp/issues/16128)
- [Commit 309b03f — Fix default player clients](https://github.com/yt-dlp/yt-dlp/commit/309b03f2ad09fcfcf4ce81e757f8d3796bb56add)
- [FAQ Wiki](https://github.com/yt-dlp/yt-dlp/wiki/FAQ)

### Official Documentation (curl_cffi, Deno, gluetun, Mullvad)
- [curl_cffi impersonate targets](https://curl-cffi.readthedocs.io/en/latest/impersonate/targets.html)
- [Deno install docs](https://docs.deno.com/runtime/getting_started/installation/)
- [denoland/deno_docker](https://github.com/denoland/deno_docker)
- [gluetun-wiki Mullvad setup](https://github.com/qdm12/gluetun-wiki/blob/main/setup/providers/mullvad.md)
- [Mullvad WireGuard help](https://mullvad.net/en/help/tag/wireguard)

### PO Token Provider
- [Brainicism/bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)

### Technical Articles (2026)
- [Fixing yt-dlp in Docker — DEV.to (Apr 2026)](https://dev.to/nareshipme/fixing-yt-dlp-in-docker-n-challenge-ejs-scripts-deno-2x-and-the-playerclientios-cookie-trap-54d6)
- [6 Ways to Get YouTube Cookies in 2026 — DEV.to](https://dev.to/osovsky/6-ways-to-get-youtube-cookies-for-yt-dlp-in-2026-only-1-works-2cnb)
- [Bypassing the 2026 YouTube "Great Wall" — DEV.to](https://dev.to/ali_ibrahim/bypassing-the-2026-youtube-great-wall-a-guide-to-yt-dlp-v2rayng-and-sabr-blocks-1dk8)
- [yt-dlp 2026 complete guide — roundproxies.com](https://roundproxies.com/blog/yt-dlp/)

### Community Resources
- [glorycloud — yt-dlp + proxies](https://www.glorycloud.com/blog/yt-dlp-scarpe-videos-proxy/)
- [proxy001.com — preventing server IP blocks](https://proxy001.com/blog/youtube-proxy-prevent-server-ip-blocks-after-deploying-yt-dlp-style-server-workloads)
- [Oxylabs — yt-dlp integration](https://developers.oxylabs.io/video-data/high-bandwidth-proxies/youtube-downloader-yt_dlp-integration)

## Open Questions

- **What is our actual Phase-1 failure rate going to be?** Numbers above are vendor-published. We should instrument the Phase-1 worker and bucket failures (`bot detection` vs `SABR-only` vs `network` vs `private/age-gated`) so the Phase-2 / Phase-2.5 trigger is data, not vibes.
- **Does Mullvad's exit pool get YouTube-rate-limited under our traffic?** A single Mullvad endpoint will route many users' traffic; if YouTube rate-limits at the IP layer we may collide with other Mullvad users. Mitigation if so: rotate `SERVER_CITIES` weekly, or move to a per-customer-IP residential proxy plan.
- **Do we need PO tokens at all if we stay on `android_vr,ios_downgraded` (the new defaults)?** The audio-only formats from those clients may be enough. Worth measuring before spinning up bgutil.
- **Does our existing `download_video.py` need to switch from `format: "bv*+ba/b"` to `format: "bestaudio[ext=m4a]/bestaudio"` to avoid ffmpeg-merge entirely?** This is what the brief decided ("Audio-only download. yt-dlp `format: 'bestaudio[ext=m4a]/bestaudio'`") but isn't reflected in the current script — confirm during Phase 1 implementation.
- **Should the impersonation target be hard-pinned for stability or kept on the `chrome` alias?** Alias is more robust to YouTube fingerprint changes; pin would protect against curl_cffi regressions. No published guidance — trial-and-error during Phase 1.
