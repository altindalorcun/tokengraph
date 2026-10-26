<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="tokengraph" src="docs/assets/logo-light.svg" height="56">
  </picture>
</p>

<h3 align="center">Yapay zekâ ile kodlamanız, GitHub tarzı bir grafik olarak.</h3>

<p align="center">
  <em>Claude Code, Codex CLI, Cursor, Gemini CLI, Cline, OpenCode, Kilo CLI, Copilot CLI, pi, Qwen Code ve Goose: tek bir grafik, README'nizde.<br>
  Kullanım verileriniz, siz yayımlamadıkça makinenizden çıkmaz; yayımladığınızda da yalnızca kendi gist'inize gider.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tokengraph"><img alt="npm version" src="https://img.shields.io/npm/v/tokengraph"></a>
  <a href="https://github.com/altindalorcun/tokengraph/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://github.com/altindalorcun/tokengraph/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/altindalorcun/tokengraph/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="https://tokengraph.app">Web sitesi</a> · <a href="https://tokengraph.app/docs/">Belgeler (İngilizce)</a> · <a href="https://www.npmjs.com/package/tokengraph">npm</a>
</p>

<p align="center">
  <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.md">English</a> · <b>Türkçe</b>
</p>

> Kaynak metin İngilizce README'dir; bu çeviri güncel olmayabilir.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/graph-dark.svg">
    <img alt="A year of daily AI coding token usage as a contribution-style graph, coloured by model family" src="docs/assets/graph-light.svg" width="900">
  </picture>
</p>

## Hızlı başlangıç

```bash
npx tokengraph            # grafiğiniz, doğrudan terminalde
npx tokengraph login      # GitHub gist'inizde yayımlayın ve README kod parçasını alın
npx tokengraph story      # kullanımınızı hikâye kartlarına dönüştürüp telefonunuza gönderin
```

Node.js 22 veya daha yenisi gerekir. README grafiğini hiç düşünmeden güncel tutmak için:
`npm install -g tokengraph && tokengraph schedule`.

## README'nize ekleyin

`tokengraph login`, grafiğinizi GitHub hesabınızdaki herkese açık bir gist'te yayımlar ve aşağıdaki
kod parçasını panoya kopyalar. Yeniden yazdırmak için `tokengraph readme` komutunu çalıştırın. Bunu profil
README'nize (`YOUR_LOGIN/YOUR_LOGIN` deposu) yapıştırın:

```html
<a href="https://github.com/altindalorcun/tokengraph">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://gist.githubusercontent.com/YOUR_LOGIN/GIST_ID/raw/tokengraph-dark.svg">
    <img alt="My AI coding token usage, made with tokengraph" src="https://gist.githubusercontent.com/YOUR_LOGIN/GIST_ID/raw/tokengraph-light.svg">
  </picture>
</a>
```

Grafik, okuyanın GitHub temasına göre açık ve koyu tema arasında geçiş yapar. Her senkronizasyon aynı gist'i
günceller, dolayısıyla kod parçası hiç değişmez. Etiketsiz, daha küçük bir grafik için `tokengraph readme --compact`,
model ailesi başına bir renk yerine tek renk için `tokengraph readme --colors single` kullanın
(`--colors model` eski haline döndürür). Aileler Claude, GPT, Gemini, DeepSeek, Qwen, GLM, Kimi, Grok, Composer (Cursor'ın kendi modelleri), Mistral, Llama ve MiniMax'tir; diğer her model "Diğer modeller" olarak sayılır.

## Gününüzü paylaşın

<p align="center">
  <img alt="Three story cards: a 3D skyline of the recent weeks, a receipt of the day's models, and a sticker with the day's total" src="docs/assets/story-strip.png" width="760">
</p>

`tokengraph story`, üç kartı (siluet, fiş ve çıkartma) Instagram ve TikTok hikâyelerine uygun boyutta PNG dosyaları olarak çizer,
ardından bunları bir QR koduyla telefonunuza göndermeyi önerir. Kodu aynı Wi-Fi ağına bağlı telefonunuzla tarayın ve kartları doğrudan Fotoğraflar'a kaydedin.
Hiçbir yere yükleme yapılmaz: bilgisayarınız, kartları kaydedene kadar ya da 10 dakika boşta kalana kadar dosyaları telefonunuza sunar.
Hangi dönemi kapsayacağını sorar (bugün, 7 gün, 30 gün veya 12 ay); soruyu `--range today|7d|30d|1y` ile atlayabilir,
tahmini maliyeti `--no-cost` ile dışarıda bırakabilirsiniz.

## Nasıl çalışır

```
agent logs on your machine ──► tokengraph ──► ~/.tokengraph ledger ──► your gists
(Claude Code, Codex, …)        dedups,         (totals only grow)       public: the SVG graph
                               weights                                  secret: daily counts per machine
```

tokengraph, ajanların zaten diske yazdığı kullanım sayaçlarını okur. İstemlerinizi (prompt) ya da yanıtları asla okumaz.
Her günün sayısı, ağırlıklı bir token sayısıdır:

```
weighted tokens = input + output + cache writes + 0.1 × cache reads
```

Cache okumalarının maliyeti, yeni girdinin maliyetinin yalnızca küçük bir kısmıdır; bu yüzden onda biri olarak sayılır. Bu olmasaydı, büyük bir cache bağlamını
tekrar tekrar okuyan tek bir uzun oturum, bir günlük gerçek işi gölgede bırakırdı. Fatura değil, yapılan işi ölçer.

- **Çifte sayım yok.** Ajanlar akış sırasında aynı mesajı diske birkaç kez yazar; devam ettirilen veya çatallanan oturumlar önceki kayıtları kopyalar.
  tokengraph, her ajanın kendi mesaj veya yanıt kimliğine (id) göre tekilleştirir ve başka bir adaptörün zaten saydığı kullanımı asla saymaz.
- **Toplamlar yalnızca artar.** Ajanlar eski döküm dosyalarını siler. Kullanım defteri, her gün için şimdiye kadar gördüğü en büyük sayıyı tutar; böylece geçmiş korunur
  ve daha küçük çıkan yeni bir tarama bu sayıyı hiçbir zaman düşürmez.

## Gizlilik

| | |
| --- | --- |
| **Makinenizden çıkanlar** | Hesabınızdaki herkese açık gist'e: SVG grafikler (günlük token toplamları ve renklendirmede kullanılan model ailelerinin adları) ile gömme kodunu ve bir bağlantıyı içeren bir README. Hesabınızdaki gizli (secret) gist'e: her makine için bir dosya (ajan, model ve fiyat katmanı başına günlük token sayıları, rastgele bir makine kimliği, `darwin-3f2a1c` gibi bir etiket, hash'lenmiş bir makine parmak izi, CLI sürümü ve son güncellemenin zamanı); Cursor verisi çekmeyi kullanıyorsanız ayrıca Cursor hesabınızın model başına günlük sayıları, hash'lenmiş bir hesap anahtarı altında; bir de kısa bir README. İkisi de yalnızca `tokengraph login` sonrasında ve yalnızca tokengraph yayımladığında (`sync`, bir hook, zamanlama, `login` veya `readme --colors`) gönderilir. `sync --local`, `story`, `status`, `export` ve `import` hiçbir zaman göndermez; `view` ise yalnızca içinde Sync'i (veya login ya da grafik renklerini) siz seçerseniz gönderir. |
| **Bu makinede kalanlar** | Her ajanı günün hangi saatinde kullandığınız. tokengraph, en yoğun saat kartı, "When you code" grafiği ve `export --hours` için ağırlıklı token'ları yerel saat başına `state.json` içinde tutar; bunlar hiçbir zaman bir makine dosyasına, veri gist'ine, grafiğe ya da hikâye kartına konmaz. Saat verisi yalnızca ajanlarınızın günlüklerinde hâlâ bulunan günler için vardır. |
| **tokengraph'ın çektikleri** | Yalnızca Cursor için ve yalnızca açıkken (Cursor'da oturum açıldığında varsayılan olarak açıktır; `tokengraph cursor off` durdurur): `sync`, Cursor'ın kendi oturum token'ını Cursor'ın yerel veritabanından okur (salt okunur, yalnızca o tek satır) ve cursor.com'dan kendi kullanım dışa aktarımınızı, yani Cursor panosundaki dışa aktar düğmesinin verdiği dosyayı ister. Token yalnızca cursor.com'a gider, istek boyunca bellekte tutulur ve asla saklanmaz, yazdırılmaz ya da günlüğe yazılmaz. Saklanan şey kullanım satırlarıdır (zaman damgaları, model adları, token sayıları). `sync --local` bunu hiçbir zaman yapmaz. |
| **Asla çıkmayanlar** | İstemler, yanıtlar, kod, dosya adları, yollar. Hiçbir tokengraph sunucusuna bir şey gönderilmez: böyle bir sunucu yok. |
| **Nasıl kaldırılır** | `tokengraph logout`, bu makinedeki GitHub girişini unutur. Yayımlananları kaldırmak için iki gist'i [gist.github.com](https://gist.github.com) adresinden silin. |

Gizli bir gist listelenmez ama özel (private) de değildir: URL'sine sahip olan herkes okuyabilir. Yukarıda sayılan alanları içerir; asla bir ana makine adı (hostname), kullanıcı adı ya da e-posta adresi içermez.
`tokengraph login` komutunu çalıştırana kadar hiçbir şey yayımlanmaz; bundan önceki tek ağ isteği cursor.com'a yapılan Cursor veri çekmesidir ve o da yalnızca bu makinede Cursor'da oturum açıksa ve siz `sync` çalıştırırsanız yapılır (`tokengraph cursor off` bunu kapatır).

## Desteklenen ajanlar

| Ajan | Nereden okur | Notlar |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` ve `transcripts` (ayrıca `$CLAUDE_CONFIG_DIR`) ile Claude masaüstü uygulamasının Code ve Cowork oturumları (`~/Library/Application Support/Claude`, `%APPDATA%\Claude`, `~/.config/Claude`) | Claude Code eski döküm dosyalarını siler, bu yüzden en az birkaç haftada bir senkronize edin. `tokengraph install-hook --agent claude-code`, oturum bittiğinde senkronize eder. |
| Codex CLI | `~/.codex/sessions` ve `archived_sessions` (ayrıca `$CODEX_HOME`) | `tokengraph install-hook --agent codex`, bir turun ardından, en fazla 10 dakikada bir senkronize eder. Kendisine ait olmayan bir `notify` ayarının üzerine asla yazmaz. |
| Cursor | cursor.com'daki kendi kullanım geçmişiniz, bu makinedeki Cursor oturumuyla çekilir (`cursor-account-*.jsonl`); gerçek zamanlı veri için Cursor'ın `stop` hook'unun yazdığı `~/.tokengraph/cursor-events.jsonl` | Cursor diskte kullanılabilir token sayıları tutmaz. Cursor'da oturum açıkken `tokengraph sync`, tüm kullanım geçmişinizi cursor.com'dan kendiliğinden, en fazla saatte bir çeker (tüm makineler, IDE, CLI ve bulut ajanları; `tokengraph cursor off` ile kapatın). Hook (`tokengraph install-hook --agent cursor`, ardından Cursor'ı yeniden başlatın) cursor.com'da henüz görünmeyen son saatleri doldurur; kullanım CSV'si (`tokengraph import cursor <csv>`) çekmeyi kapalı tutanlar içindir. Cursor'ın oturum bilgisini okumak için Node 22.13 veya daha yenisi gerekir. |
| Gemini CLI | `~/.gemini/tmp/*/chats` ve macOS sandbox'ındaki `~/.cache/.gemini/tmp` (ikisi de `$GEMINI_CLI_HOME` altında da aranır) | `tokengraph install-hook --agent gemini-cli`, oturum bittiğinde senkronize eder (Gemini CLI ayarlarına yazılır, `$GEMINI_CLI_HOME` altında da); `tokengraph schedule` yine de onu kapsar. Gemini CLI varsayılan olarak oturumları 30 gün sonra siler, bu yüzden en az ayda bir senkronize edin. Bazı yan çağrıları hiç kaydetmez, dolayısıyla toplamlar bir alt sınırdır. |
| Cline | VS Code ailesi editörlerde (VS Code, Cursor, VSCodium, Windsurf, Positron, Trae, Kiro, Antigravity ve diğerleri; Linux'ta `$XDG_CONFIG_HOME`, Windows'ta `%APPDATA%`; uzak sunucularda `~/.vscode-server` ve benzerleri) `saoudrizwan.claude-dev/tasks` ve `~/.cline/data` (ayrıca `$CLINE_DIR`, `$CLINE_DATA_DIR`, `$CLINE_SESSION_DATA_DIR`) | Cline'ın Claude Code sağlayıcısı üzerinden gönderdiği istekler atlanır, çünkü Claude Code adaptörü bunları zaten sayar. |
| OpenCode | `~/.local/share/opencode/opencode*.db` ve eski `storage/` klasörü (ayrıca `$XDG_DATA_HOME` altında; `$OPENCODE_DB` bir veritabanı daha ekler) | Veritabanını okumak için Node 22.13 veya daha yenisi gerekir. OpenCode 1.3.16 öncesine ait, kesin olarak okunamayan kayıtlar atlanır ve raporlanır. |
| Kilo CLI | `~/.local/share/kilo/kilo*.db` (ayrıca `$XDG_DATA_HOME` altında; `$KILO_DB` bir veritabanı daha ekler) | VS Code'daki Kilo Code 7.x aynı veritabanını yazar, bu yüzden o da burada sayılır. Veritabanını okumak için Node 22.13 veya daha yenisi gerekir. Kilo 7.2.6 öncesine ait, kesin olarak okunamayan kayıtlar atlanır ve raporlanır. |
| Copilot CLI | `~/.copilot/session-store.db` (ayrıca `$COPILOT_HOME`) | Copilot CLI 1.0.70 veya daha yenisi ile Node 22.13 veya daha yenisi gerekir. Yalnızca CLI'ın kendi veritabanı okunur; VS Code'daki Copilot Chat eklentisi okunmaz. Tanınmayan bir düzene sahip veritabanı atlanır ve raporlanır. |
| pi | `~/.pi/agent/sessions` (ayrıca `$PI_CODING_AGENT_DIR`, ayarlıysa `$PI_CODING_AGENT_SESSION_DIR`) | `@mariozechner/pi-coding-agent` ile ardılı `@earendil-works/pi-coding-agent` bu dosyaları aynı biçimde yazar. Çatallanan oturumlar önceki istekleri paylaşır; bunlar bir kez sayılır. Sıkıştırma (compaction) ve dal özeti çağrıları model belirtmez, bu yüzden atlanır ve raporlanır. |
| Qwen Code | `~/.qwen/projects` (`$QWEN_HOME`, `$QWEN_RUNTIME_DIR`), sohbetler ve arka plan alt ajanları, ayrıca Qwen Code'un `~/.qwen/usage` içindeki kendi kullanım defteri | `/branch` ile çatallanan sohbetler önceki istekleri kopyalar; bunlar bir kez sayılır. Qwen Code cache yazımlarını ayrı kaydetmez, bu yüzden sıradan girdi olarak sayılırlar. Arka plan alt ajanlarının dökümlerini varsayılan olarak 30 gün sonra siler, bu yüzden en az ayda bir senkronize edin. Bellek çıkarıcısının (memory extractor) isteklerinin tek yerel kaydı olan bu kullanım defteri yalnızca `privacy.usageStatisticsEnabled` açıkken (varsayılan) yazılır; kapalıyken bu istekler hiçbir yerel dosyada yer almaz ve yalnızca sohbet istekleri sayılır. |
| Goose | `~/.local/share/goose/sessions/sessions.db` (ayrıca `$XDG_DATA_HOME` veya `$GOOSE_PATH_ROOT/data` altında; Windows'ta `%APPDATA%\Block\goose\data`; bulunan her veritabanı okunur) | İstek başına kullanım defterini okur; bu yüzden böyle bir deftere sahip bir Goose sürümü ve Node 22.13 veya daha yenisi gerekir. Defter var olmadan önceki kullanımın bilinen bir günü ya da modeli yoktur; atlanır ve raporlanır. Goose üzerinden Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI veya pi'yi çalıştıran oturumlar dışarıda bırakılır, çünkü o ajanların kendi günlükleri bunları zaten sayar (Cursor için yalnızca hook'u Goose'un çalıştırmalarında tetiklenirse; bu doğrulanmadı). |

Her ajanın sayıları, Claude Code 2.1.304, Codex CLI 0.163.0, Gemini CLI 0.64.0, Cline 3.0.73, OpenCode 1.19.3, Kilo 7.8.15, Copilot CLI 1.0.100, pi 0.73.1, Qwen Code 0.25.3 ve Goose 1.55.0 sürümlerinin gerçek çalıştırmalarına karşı, desteklediği her protokolde [`scripts/e2e`](https://github.com/altindalorcun/tokengraph/blob/main/scripts/e2e/README.md) ile kontrol edilir. Cursor çevrimdışı çalıştırılamaz; CSV ayrıştırıcısı gerçek dışa aktarımlarla, veri çekme yerel bir sahte sunucuyla denendi; hook biçimi Cursor'ın belgelerine dayanır. Cline, bazı sağlayıcıların çıktı içinde bildirdiği akıl yürütme (reasoning) token'larını çıktı sayısına yazmaz; bu yüzden onlar sayılmaz.

Her ajan, varsayılan klasöründen ve ortam değişkeninin gösterdiği klasörlerden okunur. tokengraph, bu değişken ayarlıyken `sync`, `view`, `status`, `schedule` veya `install-hook` ilk kez çalıştığında o klasörü `config.json` içinde hatırlar; böylece kabuğunuzun ortamını almayan saatlik senkronizasyon ve hook'lar da onu okur. `tokengraph status` taradığı klasörleri ve var olup olmadıklarını listeler.

Cline, OpenCode, Kilo CLI, Copilot CLI, pi, Qwen Code ve Goose için hook yoktur (Gemini CLI'ınki ise isteğe bağlıdır): `tokengraph schedule` bunları her saat senkronize eder. Aider
desteklenmez, çünkü yerel geçmişi token sayılarını yuvarlar.

## Komutlar

Her komut `--help` alır. Bilinmeyen bir seçenek hata verir. Ayrıntılı kılavuz (İngilizce): [tokengraph.app/docs](https://tokengraph.app/docs/).

| Komut | Ne yapar |
| --- | --- |
| `tokengraph [view]` | Canlı terminal görünümünü açar: yıllık ısı haritası, modeller, ajanlar, seriler, günün hangi saatlerinde çalıştığınızı gösteren bir "When you code" grafiği (← → ile bir saat seçilir) ve görünümden çıkmadan hook'ları, saatlik zamanlamayı, sync'i, Cursor'ı, dışa aktarmayı ve story'yi yönettiğiniz bir Kurulum (Setup) sekmesi. `:` veya Ctrl-K komut paletini açar; her eylem CLI karşılığını gösterir. `--print` statik bir görüntü yazdırır, `--no-motion` animasyonları atlar, `--no-live` açıkken yeniden taramayı durdurur, `--theme auto\|dark\|light` temayı seçer. Terminalde varsayılan komuttur. |
| `tokengraph login` | GitHub'a bağlanır, grafiğinizi kendi gist'inizde yayımlar ve README kod parçasını yazdırır. GitHub CLI oturumunuz varsa onu kullanır (`--gh`); yoksa tarayıcıda onayladığınız tek kullanımlık bir kodu kullanır (`--device`, `--no-open`). Yalnızca gist erişimi ister. |
| `tokengraph logout` | Bu makinedeki GitHub girişini unutur. Yerel veriler ve gist'leriniz kalır. |
| `tokengraph sync` | Her ajanın günlüklerini kullanım defterine aktarır ve giriş yapılmışsa yayımlar. Cursor'da oturum açıksa önce Cursor kullanımınızı cursor.com'dan çeker (en fazla saatte bir). `--since <days>` ne kadar geriye okunacağını belirler (varsayılan 90), `--local` ağa hiç dokunmaz. |
| `tokengraph readme` | README kod parçasını yazdırır ve kopyalar. `--compact`, `--colors model\|single`. |
| `tokengraph story` | Hikâye kartlarını çizer, PNG'leri kaydeder (`--out <dir>` verilmezse İndirilenler klasörüne) ve telefonunuza göndermeyi önerir. `--template skyline\|receipt\|sticker\|all`, `--range today\|7d\|30d\|1y`, `--no-cost`, `--qr` / `--no-qr`, `--no-preview`, `--handle <name>` (varsayılan: GitHub kullanıcı adınız; giriş yapmadıysanız bilgisayarınızdaki kullanıcı adı). |
| `tokengraph status [--json]` | GitHub hesabını, kullanım defterini, makinelerinizi, hangi arka plan senkronizasyonlarının kurulu ve sağlıklı olduğunu, her ajanın hangi klasörlerden okunduğunu (ve hangilerinin var olduğunu), Claude Code, Gemini CLI ve Qwen Code'un günlükleri ne kadar süre tuttuğunu gösterir; kısa bir saklama süresi geçmişi riske attığında uyarır. `--json`, betikler ve yapay zekâ ajanları için bunu tek bir JSON nesnesi olarak yazdırır; çıktı gizli gist'in adresini ve yerel yolları içerdiğinden onu herkese açık bir yere yapıştırmayın. |
| `tokengraph install-hook --agent <claude-code\|cursor\|codex\|gemini-cli>` | O ajanın işi bitince arka planda bir senkronizasyon başlatmasını sağlar. `--remove` kaldırır, `--dry-run` nelerin değişeceğini gösterir. Claude Code için `--event SessionEnd\|Stop\|SubagentStop` hook olayını seçer (varsayılan `SessionEnd`). |
| `tokengraph schedule` | Her saat çalışan bir arka plan senkronizasyonu kurar: macOS'ta launchd, Linux'ta cron, Windows'ta Görev Zamanlayıcı. `schedule --remove` kapatır, `--dry-run` neyin kurulacağını gösterir. |
| `tokengraph export` | Günlük kullanımınızı CSV veya JSON olarak yazar; gün, ajan, model ve fiyat katmanı başına bir satır olup ağırlıklı token sayısını ve tahmini maliyeti içerir. `--format csv\|json`, `--out <file>`, `--since <date>`, `--all-machines`. `--hours` bunun yerine gün, yerel saat ve ajan başına bir satır yazar (tarih, saat, kaynak, ağırlıklı token; yalnızca bu makine). Yalnızca kullanım defterini okur. |
| `tokengraph cursor fetch\|on\|off` | Cursor kullanımınızı cursor.com'dan hemen çeker (saatlik beklemeyi yok sayar) ya da otomatik çekmeyi açar veya kapatır. `tokengraph import cursor --fetch`, `cursor fetch` ile aynı işi yapar. `status` durumunu gösterir. Cursor oturumunun süresi dolmuşsa Cursor'ı bir kez açın. |
| `tokengraph import cursor <file.csv>` | Cursor geçmişini elle ekler, çekme kapalıyken işe yarar: Cursor panosundan kullanım CSV'sini indirin (Usage, export CSV) ve buraya verin. Aynı dosyayı ya da çakışan bir dosyayı iki kez içe aktarmak hiçbir şeyi iki kez eklemez. Yalnızca tek bir makinede içe aktarın: makinelerin sayıları toplanır, bu yüzden aynı dosya iki makinede içe aktarılırsa iki kez sayılır. Hiçbir zaman yayımlamaz. |
| `tokengraph uninstall` | Claude Code, Cursor, Codex ve Gemini CLI hook'larını ve saatlik zamanlamayı kaldırır. `--purge` ayrıca `~/.tokengraph` içindeki tokengraph'ın kendi dosyalarını (kullanım defteri, giriş bilgisi, günlükler, Cursor olay, içe aktarma ve çekilen hesap dosyaları) siler, oradaki diğer hiçbir şeye dokunmaz; `--yes` soruyu atlar, `--dry-run` hiçbir şeyi değiştirmez. Gist'lerinize asla dokunulmaz. |

Hook'lar ve zamanlama, kurulu programın yolunu saklar; bu yüzden onları kullanmadan önce tokengraph'ı global olarak kurun
(`npm install -g tokengraph`). İkisi de bir `npx` cache'inden çalışmayı reddeder.

## Birden fazla makine

Her makine, kendi dosyasını (`machine-<id>.json`) gizli veri gist'ine yazar. Senkronize ettiğinizde grafik, bu makine ile diğer tüm makinelerin dosyalarının gün ve model bazında toplanmasıyla oluşturulur; böylece bir dizüstü ve bir masaüstü tek bir grafik olarak görünür. Aynı dosyalar aynı zamanda bir yedektir: yeniden kurulumdan veya `~/.tokengraph` silindikten sonra `tokengraph login` makinenizi tanır, geçmişini geri yükler ve hiçbir şeyi iki kez saymaz.

## SSS

**Neden gist?** Ücretsizdirler, size aittirler, görselleri GitHub sunar ve önbelleğe alır, ayrıca kimsenin çalıştırması, güvenmesi ya da kapatması gereken bir sunucu yoktur. tokengraph yarın ortadan kalksa bile grafiğiniz çalışmaya devam eder.

**Maliyet gerçek mi?** Tarihli bir fiyat tablosundan, herkese açık API liste fiyatlarıyla yapılmış bir tahmindir. Size kesilen fatura değildir; fatura planınıza bağlıdır. Fiyatı bilinmeyen bir model toplamın dışında bırakılır ve fiyatsız olarak işaretlenir, asla 0 $ sayılmaz; bu yüzden toplam yalnızca bir alt sınır olabilir. Fiyatlar, Claude (Anthropic), GPT ve o serisi (OpenAI), Gemini (Google), Grok (xAI) ve Cursor'ın Composer 2.5 modeli için üreticinin yayımladığı liste fiyatlarıdır. Açık ağırlıklı modeller (DeepSeek, Qwen, Llama, Mistral, MiniMax ve benzerleri) tek bir liste fiyatı olmadığı için bilerek fiyatsız bırakılır; üreticisi fiyat yayımlamayan her model de öyledir (kullanımdan kalkmış modeller, fiyatı olmayan önizlemeler, Cursor'ın Auto'su).

**Neden ağırlıklı token?** Ham toplamların çoğu cache okumasıdır; bunlar ucuzdur ama hacimleri çok büyüktür. Onları onda biri olarak saymak, grafiğin yapılan işi yansıtmasını sağlar. Formül [Nasıl çalışır](#nasıl-çalışır) bölümündedir.

**Çevrimdışı çalışır mı?** Evet. `view`, `story`, `status`, `export`, `import <file>` ve `sync --local` ağ olmadan çalışır. `view` yalnızca içinde Sync'i (veya login / renkleri) siz seçerseniz yayımlar. Yalnızca yayımlamak için GitHub, Cursor verisini çekmek (`sync`, `cursor fetch`) için ise cursor.com gerekir.

**Kullanmayı nasıl bırakırım?** `tokengraph uninstall`, Claude Code, Cursor, Codex ve Gemini CLI hook'larını ve saatlik zamanlamayı kaldırır; `--purge` ekleyerek `~/.tokengraph` içindeki tokengraph'ın kendi dosyalarını da (kullanım defteri, giriş bilgisi, günlükler, Cursor olay, içe aktarma ve çekilen hesap dosyaları) silebilirsiniz. O klasördeki diğer her şey kalır.
Ardından `npm uninstall -g tokengraph` çalıştırın. Siz silene kadar gist'leriniz GitHub'da kalır.

**Windows?** Yollar, hook'lar ve saatlik Görev Zamanlayıcı işi Windows için yazıldı, ancak tokengraph macOS ve Linux'ta geliştiriliyor; bu yüzden bazı pürüzlerle karşılaşabilirsiniz; lütfen bir issue açın.

## Katkıda bulunma

Hata raporları ve pull request'ler memnuniyetle karşılanır; bkz. [CONTRIBUTING.md](https://github.com/altindalorcun/tokengraph/blob/main/CONTRIBUTING.md). Yeni ajanlar
adaptör PR'ları olarak gelir. tokengraph'ın ne için olduğu ve neyi yapmayacağı
[ürün notlarında](https://github.com/altindalorcun/tokengraph/blob/main/docs/product.md) anlatılır.

---

tokengraph profilinizi güzelleştirdiyse, bir ⭐ başkalarının onu bulmasına yardımcı olur.

## Lisans

MIT, bkz. [LICENSE](https://github.com/altindalorcun/tokengraph/blob/main/LICENSE). Pakete dahil üçüncü taraf bileşenler için:
[THIRD-PARTY-NOTICES.md](https://github.com/altindalorcun/tokengraph/blob/main/packages/cli/THIRD-PARTY-NOTICES.md).

tokengraph bir [goldenbranch.dev](https://goldenbranch.dev) projesidir.
