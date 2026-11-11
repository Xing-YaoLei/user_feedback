"""GraphQL operation documents used by the collector.

Every request selects exactly **one** connection field.  Nested connections
are never expanded inside the same query on purpose: this keeps per-request
query complexity bounded (one page of one parent at a time), makes each parent
cursor independent, and lets a failed path be retried without re-fetching
sibling data.
"""

from __future__ import annotations

_PAGE_INFO = """
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    totalCount
"""

# Root connection: institutions.
INSTITUTIONS_QUERY = """
query InstitutionsPage($first: Int, $after: String) {
  institutions(first: $first, after: $after) {
    edges { cursor node { id name kind } }
""" + _PAGE_INFO + """
  }
}
"""

# Nested connection: experiments of one institution.
EXPERIMENTS_QUERY = """
query ExperimentsPage($id: String!, $first: Int, $after: String) {
  institution(id: $id) {
    id
    name
    kind
    experiments(first: $first, after: $after) {
      edges { cursor node { id name kind institutionId } }
""" + _PAGE_INFO + """
    }
  }
}
"""

# Nested connection: observations of one experiment.
OBSERVATIONS_QUERY = """
query ObservationsPage($id: String!, $first: Int, $after: String) {
  experiment(id: $id) {
    id
    name
    kind
    institutionId
    observations(first: $first, after: $after) {
      edges { cursor node { id name kind value measuredAt } }
""" + _PAGE_INFO + """
    }
  }
}
"""
