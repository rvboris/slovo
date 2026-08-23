# Слово

Push-to-talk транскрипция для Linux и Windows. Записывает голос по горячей клавише, отправляет на локальный Whisper-совместимый сервер и вставляет распознанный текст в активное окно.

На Linux поддерживает Wayland (через evdev) и X11; на Windows — нативные глобальные хоткеи и вставку через Win32.

## Возможности

- **Push-to-talk** — тригер на toggle, hold или auto-VAD
- **Глобальный хоткей** — работает в любой раскладке, включая Cyrillic (напр. `Ctrl+Shift+Space`)
- **Автовставка** — текст копируется в буфер и вставляется через `ydotool` (Wayland), `enigo` (X11, Windows)
- **Wayland evdev хоткеи** — через sidecar `slovo-input-helper` с udev-правилом
- **Тёмная/светлая тема** — ручной переключатель с сохранением в localStorage
- **Настройка сервера** — любой OpenAI `/v1/audio/transcriptions` совместимый эндпоинт

## Установка

### Готовые пакеты

- **Windows**: `.msi` / `.exe` (NSIS) со [страницы релизов](https://github.com/rvboris/slovo/releases) — без внешних зависимостей.
- **Linux**: `.deb` или `.AppImage` оттуда же.

### Требования

Для работы глобального хоткея на Wayland нужен `slovo-input-helper` sidecar с доступом к evdev. Пакеты `.deb` и `.AppImage` включают sidecar и udev-правило `72-slovo-input-helper.rules`, которое устанавливается автоматически при установке пакета.

При ручной установке скопируй правило:
```bash
sudo cp src-tauri/resources/72-slovo-input-helper.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
```

Для вставки текста на Wayland нужен `ydotool`, на X11 и Windows — ничего дополнительно.

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
```

Rust (stable) нужен на обеих платформах. Системные библиотеки для Tauri 2 нужны только на Linux:

```bash
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  patchelf libglib2.0-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
  libasound2-dev libxcb-randr0-dev libxcb-shape0-dev libxcb-xfixes0-dev \
  libx11-dev libxdo-dev libxkbcommon-dev libudev-dev
```

На Windows достаточно [Rust + MSVC Build Tools](https://tauri.app/start/prerequisites/) — `npm run tauri dev` работает из коробки.

### Запуск

```bash
npm run tauri dev    # dev-режим (Windows и Linux X11)
npm run dev:linux    # dev-режим с Linux-конфигом (собирает sidecar, для Wayland)
```

### Сборка

```bash
npm run tauri build  # production-сборка под текущую ОС (Windows: .msi + .exe)
npm run build:linux  # Linux: .deb + .AppImage со sidecar
```

### Проверки и тесты

```bash
npm run lint         # Biome: линт + форматирование (проверка)
npm run format       # то же с авто-исправлением
npx tsc --noEmit     # проверка типов фронтенда
npm run build        # tsc + vite build
npm run test:rust    # юнит-тесты Rust (~85 тестов: lock-протоколы, аудио, шорткаты)
```

CI (`.github/workflows/ci.yml`) запускает всё это на каждый PR: джоба фронтенда и матрица Rust (Ubuntu + Windows) с `cargo fmt --check`, `cargo clippy -D warnings` и `cargo test`.

### Отладочные скрипты

- `scripts/build-helper.js` — сборка sidecar для текущего таргета (вызывается автоматически)
- `scripts/mock-transcription-server.py` — мок Whisper-сервера на `127.0.0.1:8072` для локальной разработки
- `scripts/send-hotkey.ps1`, `scripts/test-hotkey.ps1`, `scripts/capture-overlay.ps1` — Windows-инструменты для смоук-тестов хоткея и оверлея
- `scripts/make-icon.py`, `scripts/make-ico.py` — регенерация иконок (нужен Pillow)

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

4. **CI соберёт артефакты** — GitHub Actions (`.github/workflows/release.yml`) соберёт установщики для Linux (`.deb`, `.AppImage`) и Windows (`.msi`, `.exe`) через `tauri-action` и прикрепит к Release.

### Конфигурация

- `release-please-config.json` — настройки release-please (rust release-type, extra-files)
- `.release-please-manifest.json` — текущая версия
- `.github/workflows/release.yml` — workflow: release-please + сборка Linux x86_64 и Windows x86_64

## Лицензия

MIT
