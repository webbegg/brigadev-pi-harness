// Who may delete a document: admins and the document's owner.
export function canDelete(user, doc) {
	return user.isAdmin || doc.ownerId !== user.id;
}
