# Oráculo de Primera

Pronósticos de la Primera División: probabilidad de 1X2, marcadores, quiniela sugerida, simulación de la temporada y fiabilidad medida.

Se actualiza solo dos veces al día con GitHub Actions y se publica en GitHub Pages.

- `descargar.mjs`: baja los datos de football-data.co.uk (Primera y Segunda, últimas 5 temporadas, y los próximos partidos con cuotas).
- `lib.mjs`: modelo Poisson con corrección Dixon-Coles y peso por fecha.
- `backtest.mjs`: prueba semana a semana sobre dos temporadas y fija los parámetros (`config.json`, `backtest.json`).
- `actualizar.mjs`: genera `index.html` con todo.

En local: `node actualizar.mjs` y abrir `index.html`.
