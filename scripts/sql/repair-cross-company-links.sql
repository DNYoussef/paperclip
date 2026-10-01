-- SEC-062 one-off repair: report (and optionally null) issue and project links
-- that cross a company boundary. Run the REPORT block first; the REPAIR block
-- is commented out and must be run deliberately inside a transaction after the
-- report has been reviewed.
--
-- Usage (psql): \i scripts/sql/repair-cross-company-links.sql

-- ---------------------------------------------------------------------------
-- REPORT
-- ---------------------------------------------------------------------------
select 'issue.project' as link, i.id as issue_id, i.company_id as issue_company, p.id as target_id, p.company_id as target_company
from issues i
join projects p on p.id = i.project_id
where p.company_id <> i.company_id;

select 'issue.goal' as link, i.id as issue_id, i.company_id as issue_company, g.id as target_id, g.company_id as target_company
from issues i
join goals g on g.id = i.goal_id
where g.company_id <> i.company_id;

select 'issue.parent' as link, i.id as issue_id, i.company_id as issue_company, parent.id as target_id, parent.company_id as target_company
from issues i
join issues parent on parent.id = i.parent_id
where parent.company_id <> i.company_id;

select 'project.goal' as link, p.id as project_id, p.company_id as project_company, g.id as target_id, g.company_id as target_company
from projects p
join goals g on g.id = p.goal_id
where g.company_id <> p.company_id;

select 'project_goals' as link, pg.project_id, p.company_id as project_company, pg.goal_id as target_id, g.company_id as target_company
from project_goals pg
join projects p on p.id = pg.project_id
join goals g on g.id = pg.goal_id
where g.company_id <> p.company_id or pg.company_id <> p.company_id;

-- ---------------------------------------------------------------------------
-- REPAIR (uncomment to apply; nulls the foreign link, never deletes the row)
-- ---------------------------------------------------------------------------
-- begin;
-- update issues i set project_id = null
--   from projects p where p.id = i.project_id and p.company_id <> i.company_id;
-- update issues i set goal_id = null
--   from goals g where g.id = i.goal_id and g.company_id <> i.company_id;
-- update issues i set parent_id = null
--   from issues parent where parent.id = i.parent_id and parent.company_id <> i.company_id;
-- update projects p set goal_id = null
--   from goals g where g.id = p.goal_id and g.company_id <> p.company_id;
-- delete from project_goals pg
--   using projects p, goals g
--   where p.id = pg.project_id and g.id = pg.goal_id
--     and (g.company_id <> p.company_id or pg.company_id <> p.company_id);
-- commit;
