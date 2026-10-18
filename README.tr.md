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
  <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.md">English</a> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.zh-CN.md">简体中文</a> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.ja.md">日本語</a> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.ko.md">한국어</a> · <b>Türkçe</b>
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
npx tokengraph            # your graph, right in the terminal
npx tokengraph login      # publish it to your GitHub gist and get the README snippet
npx tokengraph story      # turn today into story cards and send them to your phone
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

Grafik, okuyanın GitHub temasına göre açık ve koyu arasında geçiş yapar. Her senkronizasyon aynı gist'i
günceller, dolayısıyla kod parçası hiç değişmez. Etiketsiz, daha küçük bir grafik için `tokengraph readme --compact`,
model ailesi başına bir renk yerine tek renk için `tokengraph readme --colors single` kullanın
(`--colors model` eski haline döndürür).

## Gününüzü paylaşın

<p align="center">
  <img alt="Three story cards: a 3D skyline of the month, a receipt of the day's models, and a sticker with the day's total" src="docs/assets/story-strip.png" width="760">
</p>

`tokengraph story`, üç kartı (siluet, fiş ve etiket) Instagram ve TikTok hikâyelerine uygun boyutta PNG dosyaları olarak çizer,
ardından bir QR kodu gösterir. Aynı Wi-Fi'daki telefonunuzla tarayın ve kartları doğrudan Fotoğraflar'a kaydedin.
Hiçbir yere yükleme yapılmaz: bilgisayarınız, kartları kaydedene kadar ya da 10 dakika boşta kalana kadar dosyaları telefonunuza sunar.
Hangi dönemi kapsayacağını sorar (bugün, 7 gün, 30 gün veya 12 ay); soruyu `--range today|7d|30d|1y` ile atlayabilir,
tahmini maliyeti `--no-cost` ile dışarıda bırakabilirsiniz.

## Nasıl çalışır

```
agent logs on your machine ──► tokengraph ──► ~/.tokengraph ledger ──► your gists
(Claude Code, Codex, …)        dedups,         (totals only grow)       public: the SVG graph
                               weights                                  secret: daily counts per machine
```

tokengraph, ajanların zaten diske yazdığı kullanım sayaçlarını okur. İstemlerinizi (prompt) ya da yanıtlarınızı asla okumaz.
Her günün sayısı, ağırlıklı bir token sayısıdır:

```
weighted tokens = input + output + cache writes + 0.1 × cache reads
```

Cache okumaları taze girdinin çok küçük bir kısmı kadar maliyetlidir, bu yüzden onda biri olarak sayılır. Bu olmasaydı, büyük bir cache bağlamını
tekrar tekrar okuyan tek bir uzun oturum, bir günlük gerçek işi gölgede bırakırdı. Fatura değil, yapılan işi ölçer.

- **Çifte sayım yok.** Ajanlar akış sırasında aynı mesajı diske birkaç kez yazar; devam ettirilen veya çatallanan oturumlar önceki kayıtları kopyalar.
  tokengraph, her ajanın kendi mesaj veya yanıt kimliğine (id) göre tekilleştirir ve başka bir adaptörün zaten saydığı kullanımı asla saymaz.
- **Toplamlar yalnızca artar.** Ajanlar eski döküm dosyalarını siler. Ledger, her gün için şimdiye kadar gördüğü en büyük sayıyı tutar; böylece geçmiş korunur
  ve daha küçük çıkan yeni bir tarama bu sayıyı hiçbir zaman düşürmez.

## Gizlilik

| | |
| --- | --- |
| **Makinenizden çıkanlar** | Hesabınızdaki herkese açık gist'e: SVG grafikler (günlük token toplamları ve renklendirmede kullanılan model ailelerinin adları) ile gömme kodunu ve bir bağlantıyı içeren bir README. Hesabınızdaki gizli (secret) gist'e: gün ve model başına token sayıları, rastgele bir makine kimliği, `darwin-3f2a1c` gibi bir etiket, özetlenmiş (hash) bir makine parmak izi, CLI sürümü ve son güncellemenin zamanı. İkisi de yalnızca `tokengraph login` sonrasında ve yalnızca tokengraph yayımladığında (`sync`, bir hook, zamanlama veya `login`) gönderilir. `sync --local`, `view`, `story`, `status`, `export` ve `import` hiçbir zaman göndermez. |
| **Asla çıkmayanlar** | İstemler, yanıtlar, kod, dosya adları, yollar. Hiçbir tokengraph sunucusuna bir şey gönderilmez: böyle bir sunucu yok. |
| **Nasıl kaldırılır** | `tokengraph logout`, bu makinedeki girişi unutturur. Yayımlananları kaldırmak için iki gist'i [gist.github.com](https://gist.github.com) adresinden silin. |

Gizli bir gist listelenmez, ama özel de değildir: URL'sine sahip olan herkes okuyabilir. Yukarıda sayılan alanları içerir ve asla bir ana makine adı (hostname) içermez.
`tokengraph login` komutunu çalıştırana kadar hiçbir yere hiçbir şey gönderilmez.

## Desteklenen ajanlar

| Ajan | Nereden okur | Notlar |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` (veya `$CLAUDE_CONFIG_DIR`) | Claude Code eski döküm dosyalarını siler, bu yüzden en az birkaç haftada bir senkronize edin. `tokengraph install-hook --agent claude-code`, oturum bittiğinde senkronize eder. |
| Codex CLI | `~/.codex/sessions` ve `archived_sessions` (veya `$CODEX_HOME`) | `tokengraph install-hook --agent codex`, bir tur sonrasında, en fazla 10 dakikada bir senkronize eder. Kendisine ait olmayan bir `notify` ayarının üzerine asla yazmaz. |
| Cursor | `~/.tokengraph/cursor-events.jsonl`, Cursor'ın `stop` hook'u tarafından yazılır | Cursor diskte kullanılabilir token sayıları tutmaz; bu yüzden `tokengraph install-hook --agent cursor` komutunu bir kez çalıştırıp Cursor'ı yeniden başlatın. Kullanım o andan itibaren sayılır; geçmişinizi `tokengraph import cursor <csv>` ile içe aktarabilirsiniz. |
| Gemini CLI | `~/.gemini/tmp/*/chats` (veya `$GEMINI_CLI_HOME`) | Gemini CLI varsayılan olarak oturumları 30 gün sonra siler, bu yüzden en az ayda bir senkronize edin. Bazı yan çağrıları hiç kaydetmez, dolayısıyla toplamlar bir alt sınırdır. |
| Cline | VS Code ailesi editörlerde `saoudrizwan.claude-dev/tasks` ve `~/.cline/data` | Cline'ın Claude Code sağlayıcısı üzerinden gönderdiği istekler atlanır, çünkü Claude Code adaptörü bunları zaten sayar. |
| OpenCode | `~/.local/share/opencode/opencode*.db` ve eski `storage/` klasörü | Veritabanını okumak için Node 22.13 veya daha yenisi gerekir. OpenCode 1.3.16 öncesine ait, kesin olarak okunamayan kayıtlar atlanır ve raporlanır. |
| Kilo CLI | `~/.local/share/kilo/kilo*.db` (veya `$KILO_DB`) | VS Code'daki Kilo Code 7.x aynı veritabanını yazar, bu yüzden o da burada sayılır. Veritabanını okumak için Node 22.13 veya daha yenisi gerekir. Kilo 7.2.6 öncesine ait, kesin olarak okunamayan kayıtlar atlanır ve raporlanır. |
| Copilot CLI | `~/.copilot/session-store.db` (veya `$COPILOT_HOME`) | Copilot CLI 1.0.70 veya daha yenisi ile Node 22.13 veya daha yenisi gerekir. Yalnızca CLI'ın kendi veritabanı okunur; VS Code'daki Copilot Chat eklentisi okunmaz. Veritabanındaki hiçbir şey henüz gerçek veriyle doğrulanmadı, bu yüzden tanınmayan bir düzene sahip veritabanı atlanır ve raporlanır. |
| pi | `~/.pi/agent/sessions` (veya `$PI_CODING_AGENT_DIR`, ayarlıysa `$PI_CODING_AGENT_SESSION_DIR`) | Çatallanan oturumlar önceki istekleri paylaşır; bunlar bir kez sayılır. Sıkıştırma (compaction) ve dal özeti çağrıları model belirtmez, bu yüzden atlanır ve raporlanır. Henüz gerçek pi dosyalarıyla doğrulanmadı. |
| Qwen Code | `~/.qwen/projects` (`$QWEN_HOME`, `$QWEN_RUNTIME_DIR`), sohbetler ve arka plan alt ajanları | `/branch` ile çatallanan sohbetler önceki istekleri kopyalar; bunlar bir kez sayılır. Qwen Code cache yazımlarını ayrı kaydetmez, bu yüzden sıradan girdi olarak sayılırlar. Arka plan alt ajanlarının dökümlerini varsayılan olarak 30 gün sonra siler, bu yüzden en az ayda bir senkronize edin. Henüz gerçek Qwen Code dosyalarıyla doğrulanmadı. |
| Goose | `~/.local/share/goose/sessions/sessions.db` (`$XDG_DATA_HOME` veya `$GOOSE_PATH_ROOT/data`; Windows'ta `%APPDATA%\Block\goose\data`) | İstek başına kullanım defterini (ledger) okur; bu yüzden böyle bir deftere sahip bir Goose sürümü ve Node 22.13 veya daha yenisi gerekir. Defter var olmadan önceki kullanımın bilinen bir günü ya da modeli yoktur; atlanır ve raporlanır. Goose üzerinden Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI veya pi'yi çalıştıran oturumlar dışarıda bırakılır, çünkü o ajanların kendi günlükleri bunları zaten sayar (Cursor için yalnızca hook'u Goose'un çalıştırmalarında tetiklenirse; bu doğrulanmadı). Henüz gerçek Goose dosyalarıyla doğrulanmadı. |

Gemini CLI, Cline, OpenCode, Kilo CLI, Copilot CLI, pi, Qwen Code ve Goose için hook gerekmez: `tokengraph schedule` bunları her saat senkronize eder. Aider
desteklenmez, çünkü yerel geçmişi token sayılarını yuvarlar.

## Komutlar

Her komut `--help` alır. Bilinmeyen bir seçenek hatadır.

| Komut | Ne yapar |
| --- | --- |
| `tokengraph [view]` | Canlı terminal görünümünü açar: yıllık ısı haritası, modeller, ajanlar, seriler. `--print` statik bir görüntü yazdırır. Terminalde varsayılan komuttur. |
| `tokengraph login` | GitHub'a bağlanır, grafiğinizi kendi gist'inizde yayımlar ve README kod parçasını yazdırır. GitHub CLI oturumunuz varsa onu kullanır (`--gh`); yoksa tarayıcıda onayladığınız tek kullanımlık bir kodu kullanır (`--device`, `--no-open`). Yalnızca gist erişimi ister. |
| `tokengraph logout` | Bu makinedeki GitHub girişini unutturur. Yerel veriler ve gist'leriniz kalır. |
| `tokengraph sync` | Her ajanın günlüklerini ledger'a okur ve giriş yapılmışsa yayımlar. `--since <days>` ne kadar geriye okunacağını belirler (varsayılan 90), `--local` ağa hiç dokunmaz. |
| `tokengraph readme` | README kod parçasını yazdırır ve kopyalar. `--compact`, `--colors model\|single`. |
| `tokengraph story` | Hikâye kartlarını çizer, PNG'leri kaydeder (`--out <dir>` verilmezse İndirilenler klasörüne) ve telefonunuza göndermeyi önerir. `--template skyline\|receipt\|sticker\|all`, `--range today\|7d\|30d\|1y`, `--no-cost`, `--qr` / `--no-qr`, `--no-preview`, `--handle <name>`. |
| `tokengraph status [--json]` | GitHub hesabını, ledger'ı, makinelerinizi, hangi arka plan senkronizasyonlarının kurulu ve sağlıklı olduğunu, Claude Code, Gemini CLI ve Qwen Code'un günlükleri ne kadar süre tuttuğunu gösterir; kısa bir saklama süresi geçmişi riske attığında uyarır. `--json`, betikler ve yapay zekâ ajanları için bunu tek bir JSON nesnesi olarak yazdırır. |
| `tokengraph install-hook --agent <claude-code\|cursor\|codex>` | O ajanın işi bitince arka planda bir senkronizasyon başlatmasını sağlar. `--remove` kaldırır, `--dry-run` nelerin değişeceğini gösterir. |
| `tokengraph schedule` | Her saat çalışan bir arka plan senkronizasyonu kurar: macOS'ta launchd, Linux'ta cron, Windows'ta Görev Zamanlayıcı. `schedule --remove` kapatır. |
| `tokengraph export` | Günlük kullanımınızı CSV veya JSON olarak yazar; gün, ajan, model ve fiyat katmanı başına bir satır olup ağırlıklı token sayısını ve tahmini maliyeti içerir. `--format csv\|json`, `--out <file>`, `--since <date>`, `--all-machines`. Yalnızca ledger'ı okur. |
| `tokengraph import cursor <file.csv>` | Hook'tan önceki Cursor geçmişini ekler: Cursor panosundan kullanım CSV'sini indirin (Usage, export CSV) ve buraya verin. Aynı dosyayı ya da çakışan bir dosyayı iki kez içe aktarmak hiçbir şeyi iki kez eklemez. Yalnızca tek bir makinede içe aktarın: makineler birbirine eklenir, bu yüzden aynı dosya iki makinede iki kez sayılır. Hiçbir zaman yayımlamaz. |
| `tokengraph uninstall` | Claude Code, Cursor ve Codex hook'larını ve saatlik zamanlamayı kaldırır. `--purge` ayrıca `~/.tokengraph` içindeki tokengraph'ın kendi dosyalarını (ledger, giriş bilgisi, günlükler, Cursor olay ve içe aktarma dosyaları) siler, oradaki diğer her şeyi bırakır; `--yes` soruyu atlar, `--dry-run` hiçbir şeyi değiştirmez. Gist'lerinize asla dokunulmaz. |

Hook'lar ve zamanlama, kurulu programın yolunu saklar; bu yüzden onları kullanmadan önce tokengraph'ı global olarak kurun
(`npm install -g tokengraph`). İkisi de bir `npx` cache'inden çalışmayı reddeder.

## Birden fazla makine

Her makine, kendi dosyasını (`machine-<id>.json`) gizli veri gist'ine yazar. Senkronize ettiğinizde grafik, bu makine ile diğer tüm makinelerin dosyalarının gün ve model bazında toplanmasıyla oluşturulur; böylece bir dizüstü ve bir masaüstü tek bir grafik olarak görünür. Aynı dosyalar bir yedektir: yeniden kurulumdan veya `~/.tokengraph` silindikten sonra `tokengraph login` makinenizi tanır, geçmişini geri yükler ve hiçbir şeyi iki kez saymaz.

## SSS

**Neden gist?** Ücretsizdirler, size aittirler, görselleri GitHub sunar ve önbelleğe alır, ayrıca kimsenin çalıştırması, güvenmesi ya da kapatması gereken bir sunucu yoktur. tokengraph yarın ortadan kalksa bile grafiğiniz çalışmaya devam eder.

**Maliyet gerçek mi?** Tarihli bir fiyat tablosundan, herkese açık API liste fiyatlarıyla yapılmış bir tahmindir. Size kesilen fatura değildir; o, planınıza bağlıdır. Fiyatı bilinmeyen bir model toplamın dışında bırakılır ve fiyatsız olarak işaretlenir, asla 0 $ sayılmaz; bu yüzden toplam yalnızca bir alt sınır olabilir.

**Neden ağırlıklı token?** Ham toplamların çoğu cache okumasıdır; ucuz ve çok büyüktür. Onları onda biri olarak saymak, grafiği yapılan iş hakkında tutar. Formül [Nasıl çalışır](#nasıl-çalışır) bölümündedir.

**Çevrimdışı çalışır mı?** Evet. `view`, `story`, `status`, `export`, `import` ve `sync --local` ağı hiç kullanmaz. Yalnızca yayımlamak için GitHub gerekir.

**Nasıl bırakırım?** `tokengraph uninstall`, Claude Code, Cursor ve Codex hook'larını ve saatlik zamanlamayı kaldırır; `--purge` ekleyerek `~/.tokengraph` içindeki tokengraph'ın kendi dosyalarını da (ledger, giriş bilgisi, günlükler, Cursor olay ve içe aktarma dosyaları) silebilirsiniz. O klasördeki diğer her şey kalır.
Ardından `npm uninstall -g tokengraph` çalıştırın. Siz silene kadar gist'leriniz GitHub'da kalır.

**Windows?** Yollar, hook'lar ve saatlik Görev Zamanlayıcı işi Windows için yazıldı, ancak tokengraph macOS ve Linux'ta geliştiriliyor; bu yüzden pürüzler bekleyin ve lütfen bir issue açın.

## Katkıda bulunma

Hata raporları ve pull request'ler memnuniyetle karşılanır; bkz. [CONTRIBUTING.md](https://github.com/altindalorcun/tokengraph/blob/main/CONTRIBUTING.md). Yeni ajanlar
adaptör PR'ları olarak gelir. tokengraph'ın ne için olduğu ve neyi yapmayacağı
[ürün notlarında](https://github.com/altindalorcun/tokengraph/blob/main/docs/product.md) anlatılır.

---

tokengraph profilinizi daha iyi yaptıysa, bir ⭐ başkalarının onu bulmasına yardımcı olur.

## Lisans

MIT, bkz. [LICENSE](https://github.com/altindalorcun/tokengraph/blob/main/LICENSE). Pakete dahil üçüncü taraf bileşenler için:
[THIRD-PARTY-NOTICES.md](https://github.com/altindalorcun/tokengraph/blob/main/packages/cli/THIRD-PARTY-NOTICES.md).
