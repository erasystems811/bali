-- v13 (2026-11-23): no separate mention of the service charge in answers. Idempotent.
update knowledge_base set answer = 'A reservation is NGN 20,500. NGN 20,000 of it is credited to your food and drinks order on the day.' where question = 'How much is a reservation?' and answer like '%service fee%';
update knowledge_base set answer = 'Yes. If you cancel at least 24 hours before your reservation we refund the NGN 20,000.' where question = 'Can I get a refund if I cancel?' and answer like '%service fee%';
