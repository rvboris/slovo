# Слово

Linux-first push-to-talk транскрипция. Записывает голос по горячей клавише, отправляет на локальный Whisper-совместимый сервер и вставляет распознанный текст в активное окно.

Поддерживает Wayland (через evdev) и X11.

## Возможности

- **Push-to-talk** — тригер на toggle, hold или auto-VAD
- **Глобальный хоткей** — работает в любой раскладке, включая Cyrillic (напр. `Ctrl+Shift+Space`)
- **Автовставка** — текст копируется в буфер и вставляется через `ydotool` (Wayland) или `enigo` (X11)
- **Wayland evdev хоткеи** — через sidecar `slovo-input-helper` с udev-правилом
- **Тёмная/светлая тема** — ручной переключатель с сохранением в localStorage
- **Настройка сервера** — любой OpenAI `/v1/audio/transcriptions` совместимый эндпоинт

## Установка

### Готовые пакеты

Скачай `.deb` или `.AppImage` со [страницы релизов](https://github.com/rvboris/slovo/releases).

### Требования

Для работы глобального хоткея на Wayland нужен `slovo-input-helper` sidecar с доступом к evdev. Пакеты `.deb` и `.AppImage` включают sidecar и udev-правило `72-slovo-input-helper.rules`, которое устанавливается автоматически при установке пакета.

При ручной установке скопируй правило:
```bash
sudo cp src-tauri/resources/72-slovo-input-helper.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
```

Для вставки текста на Wayland нужен `ydotool`, на X11 — ничего дополнительно.

### Транскрипционный сервер

Нужен сервер с OpenAI-совместимым API `/v1/audio/transcriptions`. Примеры:
- [whisper.cpp server](https://github.com/ggerganov/whisper.cpp) с `--endpoint /v1/audio/transcriptions`
- [faster-whisper-server](https://github.com/fedirz/faster-whisper-server)
- Любой OpenAI-прокси

URL сервера настраивается в окне приложения. По умолчанию `http://127.0.0.1:8072`.

## Разработка

### Зависимости

```bash
# Node.js 22+
npm install

# Rust (stable)
# Системные библиотеки для Tauri 2 на Linux:
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  patchelf libglib2.0-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
  libasound2-dev libxcb-randr0-dev libxcb-shape0-dev libxcb-xfixes0-dev \
  libx11-dev libxdo-dev libxkbcommon-dev libudev-dev
```

### Запуск

```bash
npm run dev:linux     # dev-режим с Linux-конфигом (собирает sidecar)
```

### Сборка

```bash
npm run build:linux   # production-сборка: .deb + .AppImage
```

### Архитектура

- `src-tauri/src/` — Rust backend (Tauri 2)
  - `app.rs` — точка входа, регистрация команд
  - `audio.rs` — захват аудио через cpal
  - `hotkey.rs` — парсинг и обработка хоткеев
  - `state.rs` — состояние приложения, lifecycle записи
  - `transcription.rs` — клиент к Whisper-совместимому API
  - `output.rs` — вставка текста (Wayland: `ydotool`, X11: `enigo`)
  - `permissions.rs` — установка udev-правил для evdev
  - `crates/slovo-input-helper` — root sidecar для чтения evdev-устройств
  - `crates/slovo-shortcut-core` — ядро обработки шортката
- `src/` — React + Tailwind v4 + shadcn/ui фронтенд
- `scripts/build-helper.js` — сборка sidecar для текущего таргета

## Релизный цикл

Релизы управляются через [release-please](https://github.com/googleapis/release-please) + GitHub Actions. Версия синхронизируется в `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` и `.release-please-manifest.json`.

### Как выпустить релиз

1. **Коммить в `main`** используя [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` → minor bump (0.X.0)
   - `fix:` → patch bump (0.0.X)
   - `feat!:` или `BREAKING CHANGE:` → major bump (X.0.0)
   - `chore:`, `docs:`, `ci:` — не создают релиз

2. **Release-please автоматически открывает PR** `chore(main): release slovo X.Y.Z` с обновлённым `CHANGELOG.md` и версией во всех файлах.

3. **Смержи PR** — release-please создаст git-тег `slovo-vX.Y.Z` и GitHub Release.

4. **CI соберёт артефакты** — GitHub Actions (`.github/workflows/release.yml`) соберёт `.deb` и `.AppImage` через `tauri-action` и прикрепит к Release.

### Конфигурация

- `release-please-config.json` — настройки release-please (rust release-type, extra-files)
- `.release-please-manifest.json` — текущая версия
- `.github/workflows/release.yml` — workflow: release-please + сборка Linux x86_64

## Лицензия

MIT
