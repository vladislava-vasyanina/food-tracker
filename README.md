# КБЖУ Трекер

Персональный трекер питания с парсингом продуктов из супермаркетов и AI-поиском.

## Деплой на Vercel (бесплатно)

### Шаг 1 — GitHub
1. Создай аккаунт на [github.com](https://github.com) (если нет)
2. Нажми **New repository** → назови `kbzhu-tracker` → **Create repository**
3. Загрузи все файлы из этой папки в репозиторий

### Шаг 2 — Vercel
1. Зайди на [vercel.com](https://vercel.com) → **Sign up with GitHub**
2. Нажми **Add New → Project**
3. Выбери репозиторий `kbzhu-tracker`
4. В разделе **Environment Variables** добавь:
   - Name: `VITE_ANTHROPIC_KEY`  
   - Value: твой ключ с [console.anthropic.com](https://console.anthropic.com)
5. Нажми **Deploy**

Через ~1 минуту получишь ссылку типа `kbzhu-tracker.vercel.app` 🎉

## Локальный запуск

```bash
npm install
npm run dev
```

## Функции

- 📎 Добавление продуктов по ссылке из Intermarché и других магазинов
- 🤖 AI-поиск по контексту («хлопья» → нужный бренд)
- 📊 Дневник питания с расчётом КБЖУ
- 📅 Месячная статистика с дефицитом калорий
- ⚖️ Расчёт потери веса (1 кг жира = 7700 ккал)
- 🟢 Колоркодинг по диапазону дефицита (10–20% TDEE)
- 💾 Данные сохраняются в браузере
