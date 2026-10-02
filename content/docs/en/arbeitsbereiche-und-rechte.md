# Workspaces, members and permissions

A workspace belongs to a team: its own members, groups, spaces and templates. Permissions work from the workspace via the space down to the single page and the single record.

## Workspaces

- **Create**: the name at the top of the sidebar → **Create workspace**. The administrators decide whether everyone may do this.
- **Switch**: via the same name; everyone can be a member of several workspaces.
- **Settings → General**: change the name and icon, leave the workspace or – as an owner, after entering its name – delete it permanently.

When **leaving**, a last owner has to make someone else an owner first; your own spaces are handed over to a remaining owner of your choice. **Deleting** removes all content, templates, files and shares for all members and cannot be undone.

## Roles

| Role | May |
| --- | --- |
| **Owner** | Everything, plus managing members, groups, spaces and the workspace itself |
| **Edit** | Create and change pages, comment, share |
| **View** | Read and comment |
| **Guest** | Only explicitly shared pages and spaces, with view or edit access |

## Invite members

**Settings → Members → Invite member**: enter an e-mail address and role. If e-mail is set up on the instance, the person gets an invitation. They create an account with this address – even if sign-ups are otherwise closed – or sign in with SSO; the workspace appears as soon as the address is confirmed. Without e-mail, tell them yourself and send them the instance's address.

Existing members can be turned into guests with **Make guest** and back with **Make member**.

## Guests

Guests are people outside the team, such as customers or freelancers. They only see pages and spaces shared with them, including sub-pages, and cannot create pages, invite anyone or change settings. For people without any account there are [links with their own permissions](/docs/teilen#links-with-their-own-permissions) instead.

## Groups

**Settings → Groups & permissions**: form groups such as "Design" or "Sales", add members and give the group access to spaces or pages. New members of a group get its permissions right away.

## How permissions work together

1. The **space** sets the basis: open to all members or private for the people it is shared with.
2. **Pages** inherit the permissions of their space and parent pages; under **Share**, people or groups are added.
3. **Records** of a database can be made read-only or private (see [Databases](/docs/datenbanken#permissions-per-record)).
4. Linked databases, mentions and links never grant additional permissions: whoever may not read the source does not see it embedded either.

Owners of a workspace also manage other members' spaces, but do not get read access to their private pages that way.

## Storage quota

Every workspace can have a quota. Uploads, copies, templates and imports beyond it are refused. Administrators see the usage under **Administration → Workspaces**.
