# Sayfa — Ücretsiz Kişisel Kitap Okuma Uygulaması

**Sürüm:** v0.1 (ilk geliştirme sürümü, 17 Kasım 2026)

PDF dosyalarınızı tarayıcınızın cihaz içi veritabanında saklayan, okuduğunuz sayfayı hatırlayan ve PDF üzerine kalemle çizim/not almanıza olanak veren **açık kaynaklı ve ücretsiz** PWA prototipi.

## Kurulum / Çalıştırma

1. Dosyaları aynı klasörde tutun.
2. Bilgisayarda o klasörde terminal açın ve `python -m http.server 8000` komutunu çalıştırın. (Python 3 gerekir.)
3. `http://localhost:8000` adresini açın.
4. PDF motoru Mozilla PDF.js (Apache-2.0) kullanır. Varsayılan durumda ilk kullanımda internet gerekir. **Tamamen yerel PDF motoru için** internete bağlı bir bilgisayarda bir kere `python get-pdfjs.py` çalıştırın; `vendor/` klasörünü diğer uygulama dosyalarıyla birlikte barındırın.
5. Kalıcı kullanımda dosyaları ücretsiz **GitHub Pages** gibi HTTPS statik barındırmaya koyabilir, iPhone Safari'de **Paylaş > Ana Ekrana Ekle** seçeneğiyle uygulamayı açabilirsiniz. Canlı sürüm: https://chnbcc1.github.io/sayfa-kitap-okuyucu/ (GitHub Pages).

**Not:** `index.html` dosyasına doğrudan çift tıklamak yerine HTTP/HTTPS üzerinden çalıştırın. iPhone'da başka bir bilgisayarın `localhost` adresi çalışmaz; iPhone için HTTPS barındırma gerekir.

## Mevcut özellikler

- PDF dosyası ekleme, birden çok kitap, kapak önizlemesi ve kitap içinde konum kaydı.
- Her kitapta son sayfayı hatırlama, sayfa atlama, yer imi, isteğe bağlı sayfa geçiş animasyonu.
- Kurşun kalem, keçeli kalem, fosforlu kalem, elle alt/üst çizgi, silgi, not aracı.
- Sekiz renk, 1–12 arasında kalınlık, çizgi önizlemesi, geri al/ileri al.
- Çizimleri ve notları kitaptan ayrı saklama, kitap başına notları JSON olarak dışa aktarma.
- İsteğe bağlı, kullanıcı onaylı **görüntü bazlı sıkıştırma:** PDF sayfaları WebP/JPEG olarak saklanır. Sıkıştırılmış toplam boyut orijinalin %97'sinin altına inmezse orijinal PDF saklanır.
- Aydınlık/karanlık görünüm, klavye ok tuşları.
- Sunucu, veritabanı aboneliği, reklam, hesap açma veya ücretli SDK zorunluluğu yok.

## Önemli sınırlamalar (ilk sürüm)

- **Üretim sürümü değil, prototip.** Gerçek iPhone/Android/Windows cihaz testleri henüz yapılmadı.
- PDF.js varsayılan olarak CDN'den yüklenir; isteğe bağlı `get-pdfjs.py` komutu ile PDF motorunu `vendor/` klasörüne alabilirsiniz. Hizmet çalışanı (service worker) statik dosyaları önbelleğe alır; ancak **tam çevrimdışı okuma her cihazda henüz doğrulanmış değildir**. Yerel `vendor/` dosyalarını önbelleğe önceden almak için son sürümde ek geliştirme/test gerekir.
- Görüntüye dönüştürülen kitapta metin seçme/arama, metin bağlantıları ve PDF yapısal özellikleri kaybolabilir. Görsel kitap yalnızca **isteğe bağlıdır**.
- Kalemle altını/üstünü çizme şu an **elle çizilen düz çizgi** aracıdır; metin seçimine bağlı otomatik hizalama henüz yoktur.
- Metin el yazısı algılama, PDF'ye çizimleri gömülü dışa aktarma, EPUB, bulut senkronizasyonu, OCR, tam metin arama ve otomatik metin tabanlı PDF optimizasyonu bu sürümde yoktur.
- Tarayıcının depolama alanı silinir veya cihaz alanı kısıtlanırsa veriler kaybolabilir. **Orijinal PDF'lerinizi saklayın.** JSON not yedeği vardır, fakat JSON'dan içeri geri yükleme henüz yoktur.
- Büyük PDF'leri sayfa görüntülerine dönüştürme uzun sürebilir ve mobil cihazın bellek sınırına takılabilir. PDF'yi olduğu gibi saklama seçeneği daha güvenlidir.
- Uygulama GitHub Pages üzerinden dağıtılmıştır; App Store'a yüklenmemiştir ve gerçek cihazlarda uçtan uca testler henüz tamamlanmamıştır.

## Neden PWA?

Flutter ile de ücretsiz uygulama geliştirmek mümkündür. Ancak iPhone'da App Store dağıtımı **ücretli Apple Developer Program** üyeliğine tabidir. Kişisel cihazda ücretsiz Apple hesabıyla test mümkündür fakat Xcode/macOS ve imzalama süre sınırlamaları vardır. Bu yüzden sıfır abonelik gerektiren ilk aşama PWA olarak başlatılmıştır.

## Teknik özet

- `index.html`: kitaplık, okuyucu ve kalem menüsü
- `style.css`: responsive arayüz
- `app.js`: IndexedDB kitap/not kayıtları, PDF.js, vektör çizim, sıkıştırma
- `sw.js`: statik kaynak önbelleği (basit offline desteği)
- `get-pdfjs.py`: PDF.js dosyalarını ücretsiz bir defalık indirme yardımcı aracı
- `manifest.webmanifest`, `icon.svg`: PWA kurulumu
- PDF motoru: Mozilla PDF.js 4.10.38 — Apache-2.0; https://github.com/mozilla/pdf.js

## GitHub Pages yayını

Bu yayın paketinde `.github/workflows/pages.yml` bulunur. Depo oluşturulduktan sonra `Settings → Pages → Source: GitHub Actions` seçilir. Ayrıntılar için `GITHUB_YAYINLAMA.md` dosyasına bakın.

## Sonraki adımlar

1. PDF.js dosyalarını yerel paketlemek ve iPhone'da tam çevrimdışı okumayı doğrulamak.
2. Harfleri ve matematiksel ifadeleri koruyan metin tabanlı PDF optimizasyonu.
3. PDF'de seçilebilir metin katmanı + gerçek metin altı/üstü çizme.
4. Notları ve çizimleri geri yükleme/yedek paket, EPUB okuma.
5. Büyük dosyalarda performans testleri, iPhone ve Windows cihaz testleri.

**Lisans:** Bu projede yazılan kaynak kod MIT lisansıyla paylaşılır. PDF.js ayrı Apache-2.0 lisanslı açık kaynak kütüphanedir. Kullanılan açık kaynak bağımlılıkların lisans koşullarına uyulmalıdır.