# Sayfa — GitHub Pages kurulumu

Bağlanılacak GitHub hesabı: **chnbcc1**
Önerilen depo adı: **sayfa-kitap-okuyucu**
Gizlilik: **Public / Herkese açık** (GitHub Free Pages için)

1. https://github.com/new adresinde yeni depo oluşturun; `sayfa-kitap-okuyucu` adını verin. `Public` seçin ve `Add a README file` kutusunu işaretleyin.
2. Depo oluştuğunda asistan, bağlı GitHub araçları ile bu paketteki kaynak dosyaları `main` dalına ekleyebilir.
3. Depoda `Settings` → `Pages` → `Build and deployment` → `Source` bölümünden `GitHub Actions` seçin.
4. `Actions` sekmesinde `Sayfa — GitHub Pages` iş akışının başarılı olması gerekir.
5. Yayın başarıyla tamamlanırsa uygulama adresi normalde `https://chnbcc1.github.io/sayfa-kitap-okuyucu/` olacaktır. **Yayın gerçekten gerçekleşmeden bu adresin çalıştığı varsayılmamalıdır.**

İlk sürüm, kişisel PDF dosyalarını yalnızca tarayıcı içindeki IndexedDB veritabanında saklar. Hiçbir PDF veya kullanıcı notu GitHub deposuna eklenmemelidir.

Uyarı: Taranan PDF'leri görsele dönüştürme işlemi metin seçimini ortadan kaldırabilir. PDF.js varsayılan olarak ilk yüklemede CDN kullanabilir. Tam çevrimdışı PDF motoru için `get-pdfjs.py` çalıştırılmalı ve `vendor/` içeriği de depoya eklenmelidir. iOS ve Android cihaz testleri henüz tamamlanmamıştır.