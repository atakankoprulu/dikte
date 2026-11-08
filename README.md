# Dikte

Videoyu sürükle, dili seç (Türkçe / English / Español), zaman damgalı altyazı (SRT) al.
Her şey **yerel** çalışır: ses bilgisayardan çıkmaz, ücret yok, dosya boyutu sınırı yok.

Altında [whisper.cpp](https://github.com/ggml-org/whisper.cpp) + Whisper `large-v3-turbo` (q5) modeli var; Apple Silicon'da Metal ile çalışır.
M2'de 30 saniyelik konuşma ~4-5 saniyede yazıya dökülüyor.

![Dikte](docs/screenshot.png)

## Özellikler
- Sürükle-bırak, dosya seç ya da Dock ikonuna bırak / "Birlikte Aç"
- TR / EN / ES dil seçimi (dil değişince tek tıkla yeniden yaz)
- Video üstünde canlı altyazı önizlemesi, satıra tıklayınca o saniyeye atlar
- Satırları yerinde düzeltme
- SRT ve TXT olarak kaydetme, metni kopyalama
- Altyazıya uygun kısa satırlar (en fazla ~42 karakter, kelimeden bölünür)

## İndir (macOS, Apple Silicon)
1. [Releases](https://github.com/atakankoprulu/dikte/releases) sayfasından `Dikte-x.y.z-arm64.dmg` dosyasını indir, `Dikte.app`'i Applications'a sürükle.
2. Gerekli araçları kur: `brew install ffmpeg whisper.cpp`
3. Uygulama Apple tarafından onaylı (notarize) değil. İlk açılışta macOS engellerse:
   **Sistem Ayarları → Gizlilik ve Güvenlik → "Yine de Aç"**, ya da terminalde:
   `xattr -dr com.apple.quarantine /Applications/Dikte.app`

## Kaynaktan çalıştırma
```bash
brew install ffmpeg whisper.cpp
npm install
npm start          # geliştirme
npm run dist       # dist/ altında DMG üretir
```
İlk açılışta model yoksa uygulama indirmeyi önerir (~550 MB). Model şuraya iner:
`~/Library/Application Support/Dikte/models/`

Komut satırından doğrudan dosyayla açmak için: `npm start -- video.mp4`

## Lisans
MIT
