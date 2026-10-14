# RSL → mocap: импорт видеоуроков РЖЯ

Офлайн-конвейер: плейлист «Русский жестовый язык» (28 уроков, YouTube) → библиотека настоящих
motion-capture жестов для приложения (`MocapClip` из `src/lib/types.ts`) + шаблоны для распознавания.

Результат (`public/signs/rsl/`, формат 2):

| файл | что | размер |
|---|---|---|
| `manifest.json` (+`.gz`) | `{version, format: 2, source, playlist, items: [{id, gloss, aliases, ru, lesson, topic, videoId, t0, t1, clip: "clips/<id>.json", frames, quality}]}` | 410 КБ / 73 КБ gz |
| `clips/<id>.json` (+`.gz`) | один жест, квантованный формат 2 (0,5 мм, маски null, дельты по времени); декодер `src/data/clipCodec.ts` | ≈7 КБ gz (макс. 19 КБ) |
| `templates.json` + `templates.bin` (+`.gz`) | признаки распознавания всех клипов (int8, `src/vision/features.ts`), калибровка | 14 КБ + 2,5 МБ gz |

Сервер (`server/static-gz.ts`) отдаёт `.gz`-близнецы с `Content-Encoding: gzip`, ETag/304, кэш 1 день.

> **Права.** Данные получены из видео канала «Енох Иаредович / Голос Истины»
> (https://www.youtube.com/playlist?list=PL_VzOPUOoGKQQ7hyco7uz5apagoF99raf).
> Видео используются только локально для извлечения координат и в `public/` не копируются.
> Перед публичным использованием или участием в конкурсе нужно получить разрешение автора.

## Требования

- `uv` (Python 3.12 ставится автоматически; mediapipe под 3.14 нет), `uvx yt-dlp`. ffmpeg не нужен.
- Node (`npx tsx`) — шаблоны распознавания считаются тем же TypeScript-кодом, что и в браузере.
- Claude Code CLI (`claude`) — только для шага переводов (уже сделан: `glosses.json`).

## Запуск (из `tools/rsl_import/`)

```sh
uv run python download.py        # 0. плейлист + видео 720p без звука → cache/videos/lNN.mp4 (≈1 ГБ)
uv run python track.py --jobs 7  # 1. MediaPipe (pose full + hands + face) по всем кадрам → cache/track/lNN.npz (~25 мин)
uv run python captions.py        # 2. интервалы субтитров + листы для чтения → cache/captions/
#    тексты субтитров прочитаны вручную с листов cache/captions/lNN_sheetK.png → captions_text.json
uv run python gloss.py           # 3. ru → кыргызский глосс + алиасы (claude -p, один раз) → glosses.json
uv run python build.py           # 4. сегментация, сглаживание, 20 fps → clips/*.json(.gz) + manifest; затем
                                 #    сам вызывает `npx tsx tools/rsl_import/templates.ts` (шаблоны + калибровка)
```

`build.py 3 5` пересобирает только указанные уроки (остальные записи манифеста сохраняются);
`--no-templates` — не пересчитывать шаблоны.

Проверки (из корня проекта):

```sh
npx tsx tools/rsl_import/roundtrip.ts      # декодер формата 2 против исходных данных (cache/v1), ≤ 0,25 мм
npx tsx tools/rsl_import/evalrecog.ts 200  # распознавание: 200 искажённых клипов, тайминги, «неизвестные» жесты
uv run python validate.py cmp cache/val/*.png   # Python-порт трекера против браузерного
```

## Файлы

| файл | что делает |
|---|---|
| `mocap.py` | 1:1 порт `src/vision/tracker.ts` + `handedness.ts` (координаты three.js, анатомические руки, 15 blendshapes) |
| `track.py` | прогон моделей `public/models/*.task` в VIDEO-режиме, кэш сырых результатов |
| `captions.py` | детектор белого субтитра справа сверху (гистерезис, разделение «перетекающих» подписей) |
| `captions_text.json` | тексты субтитров по индексу интервала (`null` — пропуск, `"+"` — продолжение предыдущего, `["Е", 24.3, "Ё"]` — разрезать по времени) |
| `glosses.json` | `{ru: {gloss, aliases}}`; `"ru@урок"` — омографы (напр. «Есть@12» → БАР). Буквы урока 1 → `#А`…, числа урока 2 → `1`, `10`… формируются в `build.py` |
| `build.py` | границы жеста по субтитру и подъёму/опусканию рук, заполнение пропусков ≤ 4 кадров, сглаживание, 20 fps, `quality`, кодер формата 2 |
| `templates.ts` | признаки `clipFeatures` для каждого клипа → int8 (дельта по времени) + калибровка порога/температуры |
| `roundtrip.ts`, `evalrecog.ts`, `validate.py` | проверки (см. выше) |
