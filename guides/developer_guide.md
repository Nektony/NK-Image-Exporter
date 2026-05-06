# FigmaImageExporter — гайд для программиста

Этот документ — для **macOS-разработчика, который подключает выгрузку плагина** в свой Xcode-проект и использует сгенерированные ассеты в коде. Для инструкций дизайнеру см. [`designer_manual.md`](designer_manual.md). Гайд по самому плагину (как его собирать и менять) — отдельный документ.

> **Платформа: только macOS.** Сгенерированный `Contents.json` использует `idiom: "mac"`, сгенерированный Swift возвращает `NSImage` (AppKit). Для iOS / iPadOS / `UIImage` плагин в текущем виде **не годится** — потребуется отдельная конвенция и другой `idiom`.

---

## 1. Что в ZIP

После экспорта дизайнер отдаёт `images.zip`. Внутри — **одна или несколько** обёрточных папок (по одной на каждый Set):

```
images.zip
├── <SetName1>FigmaImageAssets/
│   ├── <SetName1>FigmaImageAssets.swift              ← сгенерированный enum
│   ├── <SetName1>FigmaImageAssets_images_sizes.json  ← манифест размеров (для NKExtraCompilationTool)
│   └── <SetName1>FigmaImageAssets.xcassets/          ← обычный Asset Catalog
│       ├── Contents.json
│       ├── Preview/
│       │   ├── Contents.json
│       │   ├── nk_<setname1>_macbook.imageset/
│       │   ├── nk_<setname1>_macbookLock.imageset/
│       │   └── …
│       └── …
└── <SetName2>FigmaImageAssets/                       ← только если дизайнер делал multi-set экспорт
    └── …
```

`<SetName>` — имя набора:
- В обычном (single-set) экспорте — то, что дизайнер ввёл в поле **Set Name** в плагине.
- В multi-set экспорте (когда на странице несколько `img_exp/SetName:…`-фреймов) — каждое имя берётся прямо из соответствующего фрейма. В одном `images.zip` лежит несколько обёрток сразу.

В обоих случаях с командой согласовывается список `<SetName>` (например, `Common`, `App`, `Sidebar`) — чтобы пути в Xcode-проекте были предсказуемыми.

`nk_<setname>_` — namespace на каждом ассете, защищает от коллизий с системными или сторонними бандлами. Так что если у тебя в проекте уже есть `icon_back` от стороннего pod’а — наш `nk_common_iconBack` с ним не пересечётся.

> **1x-only / 2x-only ассеты.** Дизайнер может пометить отдельный ассет маркером `img_exp/1x/foo` (только `@1x`) или `img_exp/2x/foo` (только `@2x`) — у такого imageset'а в `Contents.json` пропущенная плотность останется без `filename`, на диске соответствующий PNG не лежит. В Swift-коде разницы нет: `imageName`, `case`, raw value те же. Размер в `_images_sizes.json` всегда в **поинтах** — для 2x-only ассета значение это размер 2x PNG, поделённый на 2.

---

## 2. Куда положить файлы в Xcode-проекте

### 2.1. Где разместить папку

Папку `<SetName>FigmaImageAssets/` положи в любое место проекта — например, `App/Resources/Figma/`. Структура:

```
App/
└── Resources/
    └── Figma/
        ├── CommonFigmaImageAssets_cached_images_sizes.json   ← создастся на первом билде, см. §4
        └── CommonFigmaImageAssets/                           ← из ZIP, целиком
            ├── CommonFigmaImageAssets.swift
            ├── CommonFigmaImageAssets_images_sizes.json
            └── CommonFigmaImageAssets.xcassets/
                └── …
```

### 2.2. Что добавить в Xcode target

| Файл | В target? |
|------|-----------|
| `<SetName>FigmaImageAssets.swift` | **Да** — добавь в свой target, как обычный Swift-файл. |
| `<SetName>FigmaImageAssets.xcassets` | **Да** — Xcode подхватит как Asset Catalog. |
| `<SetName>FigmaImageAssets_images_sizes.json` | **Нет** — это служебный файл для проверки на сборке (NKExtraCompilationTool читает его сам). Просто оставь рядом в файловой системе. |
| `<SetName>FigmaImageAssets_cached_images_sizes.json` | **Нет** — тоже служебный, но **в git коммитить нужно** (см. §4). |

### 2.3. Структура папки — не трогать руками

Содержимое `<SetName>FigmaImageAssets/` целиком регенерируется при каждой выгрузке от дизайнера. Любые твои правки внутри (переименовал ассет, поправил `Contents.json`, отредактировал `.swift`) **исчезнут** при следующем обновлении.

Если нужно что-то поменять — это запрос к дизайнеру (поправить в Figma и переэкспортировать) или к разработчику плагина (поменять кодген).

---

## 3. Использование в коде

### 3.1. Базовый случай

```swift
import AppKit

imageView.image = CommonFigmaImageAssets.preview_macbookLock.image
```

Всё. Никаких `NSImage(named: "icon_back")` со строками — есть автокомплит и проверка компилятором.

### 3.2. Как читается имя case

`<lowerFolder1>_<lowerFolder2>_..._<camelCaseLeaf>` — папки в Figma становятся префиксами, имя слоя становится последним сегментом в lowerCamelCase:

| В Figma                              | В Swift                          |
|--------------------------------------|----------------------------------|
| `Preview/img_exp/macbook-lock`       | `preview_macbookLock`            |
| `Mobile/Toolbar/img_exp/icon-back`   | `mobile_toolbar_iconBack`        |
| `img_exp/ai-state` (без папки)       | `aiState`                        |

### 3.3. Все ассеты сразу — `CaseIterable`

```swift
// DEBUG: assert-проход по всем ассетам — ловит «потерявшийся» ассет рано.
#if DEBUG
CommonFigmaImageAssets.debugExistanceCheck()
#endif

// Можно итерировать
for asset in CommonFigmaImageAssets.allCases {
    print(asset.imageName, asset.image?.size as Any)
}
```

`debugExistanceCheck()` имеет смысл звать в `applicationDidFinishLaunching(_:)` под `#if DEBUG` — упадёт ассертом, если какой-то enum case не находит свой PNG в бандле.

### 3.4. Что внутри `imageName` и почему оно такое

```swift
var imageName: String { "nk_common_\(rawValue)" }
```

`imageName` — это уже готовая строка для `NSImage(named:)`. Префикс `nk_common_` собирается автоматически. Тебе как пользователю он не нужен — работай с `case`’ами.

`rawValue` — это camelCase-имя без префиксов и без иерархии (например, `"macbookLock"`). Совпадает с тем, что дизайнер видит в имени слоя после нормализации. Используй его, если нужно сравнить с чем-то внешним.

### 3.5. Удаление ассета на стороне дизайнера

Если дизайнер удалил иконку из Figma → в новой выгрузке `case` пропадёт → компилятор покажет, где он ещё используется. Это **фича**, не баг — заметишь сразу, не унесёшь сломанную ссылку в прод.

---

## 4. Build-time проверка размеров (NKExtraCompilationTool)

Плагин кладёт в каждый бандл файл `<SetName>FigmaImageAssets_images_sizes.json`:

```json
{
  "preview_macbook":     { "width": 320, "height": 240 },
  "preview_macbooklock": { "width": 320, "height": 240 },
  "preview_aistate":     { "width":  24, "height":  24 }
}
```

Это «текущие размеры всех ассетов». Ключи — Swift case-имена, **полностью приведённые к нижнему регистру** (так делает плагин при генерации манифеста). То есть Swift case `preview_macbookLock` в JSON-манифесте → ключ `preview_macbooklock`. Соседний пакет `NKExtraCompilationTool` на каждой сборке Xcode-проекта сверяет этот файл с замороженным кэшем `<SetName>FigmaImageAssets_cached_images_sizes.json`, лежащим **на уровень выше** (вне регенерируемой папки).

### 4.1. Подключение в Build Phases

В **Build Phases** твоего таргета добавь шаг **Run Script** до **Compile Sources**:

```sh
"$SRCROOT/path/to/NKExtraCompilationTool/Sources/NKExtraCompilationTool/main.sh" \
    "$DERIVED_FILE_DIR" "$SRCROOT" "$SRCROOT"
```

`main.sh` сам найдёт все `*_images_sizes.json` в проекте и вызовет проверку. Никаких ручных конфигов на каждый набор не нужно — оно само.

### 4.2. Что делает проверка

- **Кэша рядом нет** → создаёт его из текущих размеров. Молча.
- **Появился новый ассет** → добавляет запись в кэш. Молча.
- **Удалён ассет** → убирает запись из кэша. Молча.
- **Тот же ассет, размер изменился** → **ошибка сборки прямо в Xcode** с указанием имени, старого и нового размера, и пути к кэшу.

Все конфликты по всем наборам выводятся **за один прогон**, не по одной ошибке за билд.

### 4.3. Когда вылетела ошибка про размер

Текст ошибки выглядит так:

```
…/CommonFigmaImageAssets_images_sizes.json: error: image size changed for 'preview_domians':
cached 30x30, current 32x30. If this change is intentional, delete or edit
…/CommonFigmaImageAssets_cached_images_sizes.json.
```

Два варианта:

- **Изменение случайное** (дизайнер случайно подвинул слой на пару пикселей) → обратись к дизайнеру, пусть привяжет к целым координатам и переэкспортирует. После следующей выгрузки билд пройдёт без правок с твоей стороны.
- **Изменение намеренное** (новый размер UI-элемента, всё под него уже подгоняем) → открой `CommonFigmaImageAssets_cached_images_sizes.json` и **удали запись** про этот ассет (или поправь значения вручную). Следующий билд впишет актуальный размер и больше не будет ругаться.

### 4.4. Кэш-файл — версионируется в git

`<SetName>FigmaImageAssets_cached_images_sizes.json` коммитится в git как обычный код. Изменения в нём проходят ревью — это гарантирует, что «разморозка размера» не делается молча.

> Если папка `<SetName>FigmaImageAssets/` лежит в `Resources/Figma/`, то кэш — в `Resources/Figma/CommonFigmaImageAssets_cached_images_sizes.json`. На один уровень выше регенерируемой папки.

---

## 5. Несколько наборов в одном проекте

Можно держать параллельно сколько угодно наборов. Они могут приходить как из отдельных экспортов (один Set на ZIP), так и из одного multi-set экспорта (несколько обёрток в одном ZIP — раскладываешь их по тем же путям, что и в случае отдельных экспортов).

```
App/Resources/Figma/
├── CommonFigmaImageAssets_cached_images_sizes.json
├── CommonFigmaImageAssets/                          ← общие иконки
│   └── …
├── SidebarFigmaImageAssets_cached_images_sizes.json
└── SidebarFigmaImageAssets/                         ← специфичные для сайдбара
    └── …
```

Каждый — со своим namespace `nk_<setname>_`, своим enum, своей `.xcassets`. Они **не пересекаются** и обновляются независимо. В коде:

```swift
imageView.image = CommonFigmaImageAssets.preview_macbookLock.image
sidebarIcon.image = SidebarFigmaImageAssets.toolbar_settingsIcon.image
```

NKExtraCompilationTool сам найдёт все наборы через `find` — не нужно его никак конфигурировать под каждый.

---

## 6. Workflow обновления

Когда дизайнер прислал свежий ZIP:

1. **Удали** старую папку `<SetName>FigmaImageAssets/` целиком.
2. **Распакуй** новый ZIP, положи папку на то же место.
3. **Не трогай** `<SetName>FigmaImageAssets_cached_images_sizes.json` (он на уровень выше) — он сам обновится на следующем билде, если нет конфликтов.
4. **Собери проект** — если NKExtraCompilationTool не ругнулся, всё ОК; новые ассеты доступны через автокомплит.
5. **Закоммить** — и ZIP-папку, и (если кэш изменился) обновлённый `_cached_images_sizes.json`.

Если что-то добавилось / удалилось — компилятор сам покажет, что не сходится в коде.

---

## 7. Чего лучше не делать

- **Не редактировать руками** содержимое `<SetName>FigmaImageAssets/`. Любые правки исчезнут при следующей выгрузке от дизайнера.
- **Не убирать namespace-префикс `nk_<setname>_`** с ассетов в `.xcassets` — `imageName` в Swift собирает его автоматически и ожидает увидеть на диске. Уберёшь — всё сломается в рантайме.
- **Не включать `Provides Namespace`** на папках внутри `.xcassets` — текущий контракт: папки чисто организационные, `NSImage(named:)` находит ассет по плоскому имени с префиксом. Включишь — Xcode начнёт требовать полный путь, и `imageName` перестанет резолвиться.
- **Не делать stringly-typed `NSImage(named: "nk_common_iconBack")`** — теряется весь смысл генерации. Используй `case`’ы.
- **Не игнорировать ошибку про размер от NKExtraCompilationTool.** Она всегда означает одно из двух: дизайнер случайно сломал размер, или новый размер не согласован. Молча разморозить кэш — техдолг, который вылезет потом.

---

## 8. Куда смотреть дальше

- **Полная архитектурная спецификация** (как работает плагин и его выгрузка) — [`CLAUDE.md`](CLAUDE.md)
- **Инструкция дизайнеру** (что и как именовать в Figma) — [`designer_manual.md`](designer_manual.md)
- **Договорённость о том, что вообще выносится в плагин** (а что рисуется кодом или берётся из системы) — [`what_to_export.md`](what_to_export.md). Полезно перечитать с дизайнером перед тем, как закатывать новые ассеты в Figma-файл.
- **NKExtraCompilationTool** (build-time проверки, не только размеров) — `/Users/zevs/repo/nektony/packages/NKExtraCompilationTool/`
