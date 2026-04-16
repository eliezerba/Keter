# צפיין כתר ארם צובא (סטטי)

הצפיין בנוי כאתר סטטי בלבד:
- `index.html`
- `viewer.css`
- `viewer.js`

וללא צד שרת.

הערה: בדפדפנים מסוימים `fetch` נחסם כשפותחים את הקובץ ישירות כ-`file://`.
במקרה כזה, יש לפתוח את אותה תיקייה דרך שרת סטטי פשוט (למשל שרת קבצים מקומי), בלי לוגיקה שרתית.

## פרסום ל-GitHub Pages

1. להעלות את כל תוכן הפרויקט לריפו ב-GitHub (למשל דרך GitHub Desktop).
2. ב-GitHub: לפתוח `Settings` -> `Pages`.
3. תחת `Build and deployment` לבחור:
	- `Source`: `Deploy from a branch`
	- `Branch`: `main` (או `master`) ו-`/ (root)`
4. לשמור. לאחר כדקה-שתיים יופיע קישור לאתר.

## טעינה מתיקייה ציבורית ב-Google Drive

הצפיין כולל מצב טעינה מ-Drive דרך Google Drive API (Client-side בלבד, מתאים ל-GitHub Pages).

מה נדרש:
- תיקייה ציבורית (`Anyone with the link`).
- API key של Google Cloud עם הפעלת `Google Drive API`.

שלבי הגדרה ל-API key:
1. לפתוח פרויקט ב-Google Cloud Console.
2. להפעיל `Google Drive API`.
3. ליצור `API key` תחת `APIs & Services` -> `Credentials`.
4. מומלץ להגביל את המפתח:
	- `Application restrictions`: `HTTP referrers`
	- להוסיף את דומיין GitHub Pages שלך.
	- `API restrictions`: להגביל ל-`Google Drive API`.

שימוש בצפיין:
1. להדביק בתיבה את קישור התיקייה (או Folder ID).
2. להדביק את ה-API key.
3. ללחוץ `טעינה מ-Google Drive`.

## מה קיים בצפיין

- תצוגה מקבילה: טקסט ותמונה זה לצד זה.
- היררכיה מקראית: ספר / פרק / פסוק.
- ניווט בין עמודים לפי סדר שמות קבצים (`182r`, `182v`, `183r`...).
- לחיצה על מילה בטקסט או בתמונה מדגישה את המקבילה בצד השני.
- לחיצה על מספר פסוק מדגישה את כל הפסוק על גבי התמונה.

## קבצי דאטה

הצפיין משתמש ב:
- `Keter-Image_And_Alto/manifest.json` (רשימת העמודים והסדר)
- `Keter-Image_And_Alto/alto_blocks_to_bible_aligned.json` (מיפוי שורות ALTO לפסוקים)
- קובצי `*_with_bible_text.xml`
- קובצי תמונה `*.jpg`

## עדכון עמודים חדשים

כדי להוסיף עמוד חדש:
1. להוסיף לתיקייה את ה-`jpg` וה-`with_bible_text.xml`.
2. לוודא שיש רשומות מתאימות ב-`alto_blocks_to_bible_aligned.json`.
3. להוסיף רשומה חדשה ל-`manifest.json` לפי אותו מבנה.
