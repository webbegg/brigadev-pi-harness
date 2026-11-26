// URL slug of a title: lower case, words joined by single dashes.
export function slugify(title) {
	return title.trim().toLowerCase().replace(/ /g, "-");
}
