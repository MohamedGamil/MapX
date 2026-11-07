# vue-http fixture

Synthetic Vue 2.7 (`vue2/`) and Vue 3 (`vue3/`) front ends for scoring frontend HTTP call extraction and pairing with backend routes (docs/baton M2-02, D008). The backend is `../laravel-routes`. Every labelled call carries a `/* Lnn */` marker; `labels.json` gives its method, resolved URL and expected route. All code is invented.

`partners-api/` is a second, minimal Laravel app (copied like the front ends, as `frontend-partners-api/`). Its only route sits on `Route::domain('partners.example.com')`, and no `.env` or setting names that host: L49 checks that a literal route domain is a workspace host on its own (M2-06-R4).
