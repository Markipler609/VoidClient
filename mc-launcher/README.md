# VOID CLIENT

VOID CLIENT — Minecraft launcher с Y2K-эстетикой, написанный на **Electron**. Поддерживает vanilla и все популярные загрузчики модов: **Fabric, Forge, NeoForge, Quilt** для Minecraft 1.21.4+.

Проект **с открытым исходным кодом** — вы можете свободно модифицировать, форкать и распространять его.

## Возможности

- 🚀 Запуск **Minecraft** (чистый vanilla) с автоматическим скачиванием клиента, библиотек и ассетов
- 🧩 Установщики загрузчиков: **Fabric, Forge, NeoForge, Quilt**
- 🎨 Кастомизация интерфейса: темы, цвета, эффекты частиц, фон (картинка/видео)
- 🛠️ Поиск и установка модов с **Modrinth**
- 👤 Вход через **Microsoft** (OAuth Device Flow) **и** офлайн-режим
- 🔒 Хранение токенов в зашифрованном виде (`electron.safeStorage` / DPAPI)
- ✅ Проверка целостности скачанных файлов по **SHA1**
- 🖥️ Автоопределение Java с кэшированием

## Требования

- Node.js 18+ (для сборки)
- Java 21+ (для запуска Minecraft 1.21.4; автоопределяется)
- Windows (поддержка Linux/macOS заложена, но протестирована на Windows)

## Сборка и запуск

```bash
npm install
npx electron .          # запуск лаунчера в режиме разработки
npm run build           # сборка установщика (electron-builder)
```

## Настройка Microsoft-входа

Microsoft OAuth требует **Client ID** зарегистрированного приложения в Azure:

1. Откройте [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. Укажите имя; в «Supported account types» выберите *Personal Microsoft accounts only* (или *Accounts in any directory*).
3. В разделе *Authentication* включите тип **Public client/native** и добавьте redirect URI:
   `https://login.microsoftonline.com/common/oauth2/nativeclient`
4. Скопируйте **Application (client) ID**.
5. Вставьте его в файл `src/microsoft-auth.js`:

```js
const CLIENT_ID = ''; // <- сюда ваш Client ID
```

Без Client ID кнопка «Microsoft» сообщит, что вход не настроен.

## Структура

```
main.js               — главный процесс (окно, IPC, запуск игры, загрузчики, скачивание)
src/index.html        — интерфейс
src/style.css         — стили
src/renderer.js       — логика интерфейса
src/microsoft-auth.js — Microsoft OAuth + хранилище токенов (зашифрованное)
```

## Безопасность

- **Токены** (refresh / Minecraft access) не хранятся в открытом виде и **никогда не пишутся в логи** — используются `electron.safeStorage` (DPAPI на Windows).
- **SHA1-проверка** клиентского jar и библиотек защищает от битой загрузки/подмены.
- Если вы форкаете проект — **не коммитьте свой Client ID** в публичный репозиторий. Оставьте его заполняемым через переменную окружения или локальный файл конфигурации.

## Лицензия

Смотрите [LICENSE](LICENSE).
