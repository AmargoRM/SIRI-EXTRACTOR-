/* Cobertura del catastro SIRI por cantón. Generado con tools/cobertura.py.
 * estado: "ok" (hay fincas), "parcial" (fincas solo en parte del cantón), "sin_datos" (no hay fincas).
 * Clave: "Provincia|Cantón", igual que en data/cantones.js. Si la lista está vacía, la página no bloquea nada
 * y solo usa la consulta rápida antes de empezar. */
window.SIRI_COBERTURA = { generado: null, cantones: {} };
