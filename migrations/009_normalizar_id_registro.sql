BEGIN;

WITH normalizados AS (
  SELECT btrim(id_registro) AS id_limpo, count(*) AS total
    FROM public.nacionalidade_portuguesa
   WHERE id_registro IS NOT NULL
   GROUP BY btrim(id_registro)
)
UPDATE public.nacionalidade_portuguesa n
   SET id_registro=btrim(n.id_registro)
  FROM normalizados x
 WHERE x.id_limpo=btrim(n.id_registro)
   AND x.total=1
   AND n.id_registro IS DISTINCT FROM btrim(n.id_registro);

COMMIT;
