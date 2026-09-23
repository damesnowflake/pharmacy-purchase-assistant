insert into products(id, name, base_unit, observed_from)
values ('00000000-0000-0000-0000-000000000099', 'concurrent queue test', 'ea', current_date);
select enqueue_recompute('00000000-0000-0000-0000-000000000099', true);
