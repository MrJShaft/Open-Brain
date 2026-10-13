update public.thoughts set content_fingerprint = encode(sha256(convert_to(lower(trim(regexp_replace(content,'\s+',' ','g'))),'UTF8')),'hex') where content_fingerprint is null;
