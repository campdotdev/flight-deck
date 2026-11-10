// The GraphQL the Linear half of the contract suite sends as the maintainer, outside the Tracker port: to find
// the issue Linear's GitHub sync made, to read the raw fields the adapter's rules depend on, and to check what the
// port can't show. `linear-queries.test.ts` validates each one against Linear's schema in CI.

export const VIEWER = `query ContractViewer { viewer { id name } }`;

export const ISSUE_BY_TITLE = `query ContractIssueByTitle($team: String!, $title: String!) {
  issues(first: 5, filter: { team: { key: { eq: $team } }, title: { eq: $title } }) { nodes { id identifier } }
}`;

/** The raw sync fields: which of `externalUser` and `syncedWith` marks a synced comment, and the attachment's `sourceType`. */
export const SYNC_FACTS = `query ContractSyncFacts($id: String!) {
  issue(id: $id) {
    id
    syncedWith { service id }
    attachments(first: 20) { nodes { id url sourceType } }
    comments(first: 50) { nodes { id body user { id } externalUser { id } syncedWith { service id } } }
  }
}`;

export const UPDATED_AT = `query ContractUpdatedAt($id: String!) { issue(id: $id) { id updatedAt } }`;

export const STATE = `query ContractState($id: String!) { issue(id: $id) { id state { name type } } }`;

export const INVERSE_RELATIONS = `query ContractInverseRelations($id: String!) {
  issue(id: $id) { id inverseRelations(first: 20) { nodes { type issue { id } relatedIssue { id } } } }
}`;

export const RELATE = `mutation ContractRelate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }`;

export const COMMENT = `mutation ContractComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`;

export const NOT_FOUND = `query ContractNotFound($id: String!) { issue(id: $id) { id } }`;
