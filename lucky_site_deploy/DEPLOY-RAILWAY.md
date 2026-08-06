# Publicación en Railway — guía paso a paso

Esta versión está preparada para Railway mediante `Dockerfile` y `railway.json`.

## Requisitos previos

1. Una cuenta de GitHub.
2. Una cuenta de Railway.
3. Una tarjeta o método de pago válido para el plan Hobby, porque la base SQLite necesita un volumen persistente.
4. Un dominio propio es opcional al comienzo; Railway proporciona primero una dirección temporal.

## Etapa 1: subir el proyecto a GitHub

1. Cree un repositorio privado, por ejemplo `biblioteca-luis-gurovich`.
2. Descomprima este proyecto.
3. Suba todos los archivos y carpetas, incluidos `private/books/` y `public/covers/`.
4. No suba un archivo `.env` ni una base `downloads.db` existente.

Nota: el PDF más grande tiene menos de 100 MB, por lo que puede alojarse en un repositorio GitHub ordinario. El conjunto completo es voluminoso; la primera subida puede demorar.

## Etapa 2: crear el servicio

1. En Railway, elija **New Project**.
2. Seleccione **Deploy from GitHub repo**.
3. Autorice Railway para acceder al repositorio privado.
4. Seleccione el repositorio de la biblioteca.
5. Railway detectará el `Dockerfile` y construirá el servicio.

## Etapa 3: variables privadas

En la sección **Variables**, agregue:

- `ADMIN_KEY`: una clave aleatoria de al menos 32 caracteres.
- `DATA_DIR`: `/app/data`
- `SITE_NAME`: `Biblioteca Digital de Luis Gurovich`

Railway define `PORT` automáticamente. No es necesario asignarlo manualmente.

## Etapa 4: volumen persistente

1. Abra el servicio y seleccione **Volumes**.
2. Cree un volumen.
3. Use como punto de montaje exacto: `/app/data`
4. Vuelva a desplegar el servicio.

El volumen conserva la base `downloads.db` durante reinicios y nuevas publicaciones. No monte el volumen sobre `/app` ni sobre `/app/private`, porque ocultaría los archivos incluidos en la imagen.

## Etapa 5: dominio temporal y prueba

1. En **Settings > Networking**, genere un dominio Railway.
2. Abra la dirección asignada.
3. Compruebe `/salud`; debe responder `{"ok":true}`.
4. Realice una descarga de prueba.
5. Abra `/admin.html`, escriba la clave administrativa y verifique que la descarga figure en el registro.
6. Exporte el CSV y ábralo con Excel.

## Etapa 6: dominio propio

1. Compre o use un dominio existente.
2. En Railway, añada el dominio en **Custom Domain**.
3. Copie en el proveedor del dominio los registros DNS que Railway indique.
4. Espere la propagación.
5. Railway aprovisionará HTTPS automáticamente cuando el DNS esté correctamente conectado.

## Etapa 7: tareas antes de anunciar el sitio

- Reemplazar en `public/privacidad.html` las frases provisionales por un correo real de contacto.
- Elegir la dirección definitiva del panel administrativo y conservar `ADMIN_KEY` fuera de documentos públicos.
- Descargar periódicamente el CSV de registros.
- Crear copias de seguridad del volumen o de `downloads.db`.
- Probar las ocho descargas desde computador y teléfono.
- Confirmar que las portadas, títulos y autores sean los definitivos.

## Costos

Railway utiliza un plan de entrada y facturación por uso. El costo exacto depende de CPU, memoria, transferencia y volumen. Revise el panel de costos antes de activar el servicio de forma permanente.
